import {
  FunctionReference,
  GenericMutationCtx,
  IndexRangeBuilder,
  RegisteredMutation,
  internalMutationGeneric as internalMutation,
  makeFunctionReference,
} from "convex/server";
import { GenericId, Infer, convexToJson, v } from "convex/values";
import { getEdgeDefinitions } from "./functions";
import { GenericEntsDataModel } from "./schema";

export type ScheduledDeleteFuncRef = FunctionReference<
  "mutation",
  "internal",
  {
    origin: Origin;
    stack: Stack;
    inProgress: boolean;
  },
  void
>;

type Origin = {
  id: string;
  table: string;
  deletionTime: number;
};

const vApproach = v.union(v.literal("cascade"), v.literal("paginate"));

type Approach = Infer<typeof vApproach>;

export function scheduledDeleteFactory<
  EntsDataModel extends GenericEntsDataModel,
>(
  entDefinitions: EntsDataModel,
  options?: {
    scheduledDelete: ScheduledDeleteFuncRef;
  },
): RegisteredMutation<
  "internal",
  { origin: Origin; stack: Stack; inProgress: boolean },
  Promise<void>
> {
  const selfRef =
    options?.scheduledDelete ??
    (makeFunctionReference(
      "functions:scheduledDelete",
    ) as unknown as ScheduledDeleteFuncRef);
  return internalMutation({
    args: {
      origin: v.object({
        id: v.string(),
        table: v.string(),
        deletionTime: v.number(),
      }),
      stack: v.array(
        v.union(
          v.object({
            id: v.string(),
            table: v.string(),
            edges: v.array(
              v.object({
                approach: vApproach,
                table: v.string(),
                indexName: v.string(),
              }),
            ),
          }),
          v.object({
            approach: vApproach,
            cursor: v.union(v.string(), v.null()),
            table: v.string(),
            indexName: v.string(),
            fieldValue: v.any(),
          }),
        ),
      ),
      inProgress: v.boolean(),
    },
    handler: async (ctx, { origin, stack, inProgress }) => {
      const originId = ctx.db.normalizeId(origin.table, origin.id);
      if (originId === null) {
        throw new Error(`Invalid ID "${origin.id}" for table ${origin.table}`);
      }
      // Check that we still want to delete
      // Note: Doesn't support scheduled deletion starting with system table
      const doc = await ctx.db.get(originId);
      if (doc.deletionTime !== origin.deletionTime) {
        if (inProgress) {
          console.error(
            `[Ents] Already in-progress scheduled deletion for "${origin.id}" was cancelled!`,
          );
        } else {
          console.log(
            `[Ents] Scheduled deletion for "${origin.id}" was cancelled`,
          );
        }
        return;
      }
      await progressScheduledDeletion(
        { ctx, entDefinitions, selfRef, origin },
        newCounter(),
        inProgress
          ? stack
          : [
              {
                id: originId,
                table: origin.table,
                edges: getEdgeArgs(entDefinitions, origin.table),
              },
            ],
      );
    },
  });
}

// Heuristic:
// Ent at the end of an edge
//  has soft or scheduled deletion behavior && has cascading edges: schedule individually
//  has cascading edges: paginate by 1
//  else: paginate by decent number
function getEdgeArgs(entDefinitions: GenericEntsDataModel, table: string) {
  const edges = getEdgeDefinitions(entDefinitions, table);
  return Object.values(edges).flatMap((edgeDefinition) => {
    if (
      (edgeDefinition.cardinality === "single" &&
        edgeDefinition.type === "ref") ||
      (edgeDefinition.cardinality === "multiple" &&
        edgeDefinition.type === "field")
    ) {
      const table = edgeDefinition.to;
      const targetEdges = getEdgeDefinitions(entDefinitions, table);
      const hasCascadingEdges = Object.values(targetEdges).some(
        (edgeDefinition) =>
          (edgeDefinition.cardinality === "single" &&
            edgeDefinition.type === "ref") ||
          edgeDefinition.cardinality === "multiple",
      );
      const approach = hasCascadingEdges ? "cascade" : "paginate";

      const indexName = edgeDefinition.ref;
      return [{ table, indexName, approach } as const];
    } else if (edgeDefinition.cardinality === "multiple") {
      const table = edgeDefinition.table;
      return [
        {
          table,
          indexName: edgeDefinition.field,
          approach: "paginate",
        } as const,
        ...(edgeDefinition.symmetric
          ? [
              {
                table,
                indexName: edgeDefinition.ref,
                approach: "paginate",
              } as const,
            ]
          : []),
      ];
    } else {
      return [];
    }
  });
}

type PaginationArgs = {
  approach: Approach;
  table: string;
  cursor: string | null;
  indexName: string;
  fieldValue: any;
};

type EdgeArgs = {
  approach: Approach;
  table: string;
  indexName: string;
};

type Stack = (
  | { id: string; table: string; edges: EdgeArgs[] }
  | PaginationArgs
)[];

type CascadeCtx = {
  ctx: GenericMutationCtx<any>;
  entDefinitions: GenericEntsDataModel;
  selfRef: ScheduledDeleteFuncRef;
  origin: Origin;
};

async function progressScheduledDeletion(
  cascade: CascadeCtx,
  counter: Counter,
  stack: Stack,
) {
  const { ctx } = cascade;
  const last = stack[stack.length - 1];

  if ("id" in last) {
    const edgeArgs = last.edges[0];
    if (edgeArgs === undefined) {
      await ctx.db.delete(last.id as GenericId<any>);
      if (stack.length > 1) {
        await continueOrSchedule(cascade, counter, stack.slice(0, -1));
      }
    } else {
      const updated = { ...last, edges: last.edges.slice(1) };
      await paginateOrCascade(
        cascade,
        counter,
        stack.slice(0, -1).concat(updated),
        {
          cursor: null,
          fieldValue: last.id,
          ...edgeArgs,
        },
      );
    }
  } else {
    await paginateOrCascade(cascade, counter, stack, last);
  }
}

const MAXIMUM_DOCUMENTS_READ = 8192 / 4;
const MAXIMUM_BYTES_READ = 2 ** 18;

async function paginateOrCascade(
  cascade: CascadeCtx,
  counter: Counter,
  stack: Stack,
  { table, approach, indexName, fieldValue, cursor }: PaginationArgs,
) {
  const { ctx, entDefinitions } = cascade;
  const { page, continueCursor, isDone, bytesRead } = await paginate(
    ctx,
    { table, indexName, fieldValue },
    {
      cursor,
      ...limitsBasedOnCounter(
        counter,
        approach === "paginate"
          ? { numItems: MAXIMUM_DOCUMENTS_READ }
          : { numItems: 1 },
      ),
    },
  );

  const updatedCounter = incrementCounter(counter, page.length, bytesRead);
  const updated = {
    approach,
    table,
    cursor: continueCursor,
    indexName,
    fieldValue,
  };
  const relevantStack = cursor === null ? stack : stack.slice(0, -1);
  const updatedStack =
    isDone && (approach === "paginate" || page.length === 0)
      ? relevantStack
      : relevantStack.concat(
          approach === "cascade"
            ? [
                updated,
                {
                  id: page[0]._id,
                  table,
                  edges: getEdgeArgs(entDefinitions, table),
                },
              ]
            : [updated],
        );
  if (approach === "paginate") {
    await Promise.all(page.map((doc) => ctx.db.delete(doc._id)));
  }
  await continueOrSchedule(cascade, updatedCounter, updatedStack);
}

async function continueOrSchedule(
  cascade: CascadeCtx,
  counter: Counter,
  stack: Stack,
) {
  if (shouldSchedule(counter)) {
    const { ctx, selfRef, origin } = cascade;
    await ctx.scheduler.runAfter(0, selfRef, {
      origin,
      stack,
      inProgress: true,
    });
  } else {
    await progressScheduledDeletion(cascade, counter, stack);
  }
}

type Counter = {
  numDocuments: number;
  numBytesRead: number;
};

function newCounter() {
  return {
    numDocuments: 0,
    numBytesRead: 0,
  };
}

function incrementCounter(
  counter: Counter,
  numDocuments: number,
  numBytesRead: number,
) {
  return {
    numDocuments: counter.numDocuments + numDocuments,
    numBytesRead: counter.numBytesRead + numBytesRead,
  };
}

function limitsBasedOnCounter(
  counter: Counter,
  { numItems }: { numItems: number },
) {
  return {
    numItems: Math.max(1, numItems - counter.numDocuments),
    maximumBytesRead: Math.max(1, MAXIMUM_BYTES_READ - counter.numBytesRead),
  };
}

function shouldSchedule(counter: Counter) {
  return (
    counter.numDocuments >= MAXIMUM_DOCUMENTS_READ ||
    counter.numBytesRead >= MAXIMUM_BYTES_READ
  );
}

async function paginate(
  ctx: GenericMutationCtx<any>,
  {
    table,
    indexName,
    fieldValue,
  }: { table: string; indexName: string; fieldValue: any },
  {
    cursor,
    numItems,
    maximumBytesRead,
  }: {
    cursor: string | null;
    numItems: number;
    maximumBytesRead: number;
  },
) {
  const query = ctx.db
    .query(table)
    .withIndex(indexName, (q) =>
      (q.eq(indexName, fieldValue) as IndexRangeBuilder<any, any, any>).gt(
        "_creationTime",
        cursor === null ? cursor : +cursor,
      ),
    );

  let bytesRead = 0;
  const results = [];
  let isDone = true;

  for await (const doc of query) {
    if (results.length >= numItems) {
      isDone = false;
      break;
    }
    const size = JSON.stringify(convexToJson(doc)).length * 8;

    results.push(doc);
    bytesRead += size;

    // Check this after we read the doc, since reading it already
    // happened anyway, and to make sure we return at least one
    // result.
    if (bytesRead > maximumBytesRead) {
      isDone = false;
      break;
    }
  }
  return {
    page: results,
    continueCursor:
      results.length === 0
        ? cursor
        : "" + results[results.length - 1]._creationTime,
    isDone,
    bytesRead,
  };
}
