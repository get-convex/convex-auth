import {
  DocumentByName,
  GenericDocument,
  TableNamesInDataModel,
  makeFunctionReference,
} from "convex/server";
import { GenericId } from "convex/values";
import {
  EntMutationCtx,
  entWrapper,
  getDeletionConfig,
  getEdgeDefinitions,
  getReadRule,
  getWriteRule,
} from "./functions";
import { FieldConfig, GenericEdgeConfig, GenericEntsDataModel } from "./schema";
import { ScheduledDeleteFuncRef } from "./deletion";

export class WriterImplBase<
  EntsDataModel extends GenericEntsDataModel,
  Table extends TableNamesInDataModel<EntsDataModel>,
> {
  constructor(
    protected ctx: EntMutationCtx<EntsDataModel>,
    protected entDefinitions: EntsDataModel,
    protected table: Table,
  ) {}

  async deleteId(id: GenericId<any>, behavior: "default" | "soft" | "hard") {
    await this.checkReadAndWriteRule("delete", id, undefined);

    const deletionConfig = getDeletionConfig(this.entDefinitions, this.table);

    const isDeletingSoftly =
      behavior !== "hard" &&
      deletionConfig !== undefined &&
      (deletionConfig.type === "soft" || deletionConfig.type === "scheduled");

    if (behavior === "soft" && !isDeletingSoftly) {
      throw new Error(
        `Cannot soft delete document with ID "${id}" in ` +
          `table "${this.table}" because it does not have an ` +
          `"allowSoft", "soft" or "scheduled" deletion behavior configured.`,
      );
    }
    const edges: EdgeChanges = {};
    await Promise.all(
      Object.values(getEdgeDefinitions(this.entDefinitions, this.table)).map(
        async (edgeDefinition) => {
          const key = edgeDefinition.name;
          if (
            (edgeDefinition.cardinality === "single" &&
              edgeDefinition.type === "ref") ||
            (edgeDefinition.cardinality === "multiple" &&
              edgeDefinition.type === "field")
          ) {
            if (!isDeletingSoftly || edgeDefinition.deletion === "soft") {
              const remove = (
                await this.ctx.db
                  .query(edgeDefinition.to)
                  .withIndex(edgeDefinition.ref, (q) =>
                    q.eq(edgeDefinition.ref, id as any),
                  )
                  .collect()
              ).map((doc) => doc._id as GenericId<any>);
              edges[key] = { remove };
            }
          } else if (edgeDefinition.cardinality === "multiple") {
            if (!isDeletingSoftly) {
              const removeEdges = (
                await this.ctx.db
                  .query(edgeDefinition.table)
                  .withIndex(edgeDefinition.field, (q) =>
                    q.eq(edgeDefinition.field, id as any),
                  )
                  .collect()
              )
                .concat(
                  edgeDefinition.symmetric
                    ? await this.ctx.db
                        .query(edgeDefinition.table)
                        .withIndex(edgeDefinition.ref, (q) =>
                          q.eq(edgeDefinition.ref, id as any),
                        )
                        .collect()
                    : [],
                )
                .map((doc) => doc._id as GenericId<any>);
              edges[key] = { removeEdges };
            }
          }
        },
      ),
    );
    const deletionTime = +new Date();
    if (isDeletingSoftly) {
      await this.ctx.db.patch(id, { deletionTime });
    } else {
      try {
        await this.ctx.db.delete(id);
      } catch (e) {
        // TODO:
        // For now we're gonna ignore errors here,
        // because we assume that the only error
        // is "document not found", which
        // can be caused by concurrent deletions.
        // In the future we could track which
        // edges are being deleted by this mutation,
        // and skip the call to delete altogether
        // - or Convex could implement this.
      }
    }
    await this.writeEdges(id, edges, isDeletingSoftly);
    if (deletionConfig !== undefined && deletionConfig.type === "scheduled") {
      const fnRef = ((this.ctx as any).scheduledDelete ??
        makeFunctionReference(
          "functions:scheduledDelete",
        )) as ScheduledDeleteFuncRef;
      await this.ctx.scheduler.runAfter(deletionConfig.delayMs ?? 0, fnRef, {
        origin: {
          id,
          table: this.table,
          deletionTime,
        },
        inProgress: false,
        stack: [],
      });
    }
    return id;
  }

  async deletedIdIn(id: GenericId<any>, table: string, cascadingSoft: boolean) {
    await new WriterImplBase(this.ctx, this.entDefinitions, table).deleteId(
      id,
      cascadingSoft ? "soft" : "hard",
    );
  }

  async writeEdges(
    docId: GenericId<any>,
    changes: EdgeChanges,
    deleteSoftly?: boolean,
  ) {
    await Promise.all(
      Object.values(getEdgeDefinitions(this.entDefinitions, this.table)).map(
        async (edgeDefinition) => {
          const idOrIds = changes[edgeDefinition.name];
          if (idOrIds === undefined) {
            return;
          }
          if (
            (edgeDefinition.cardinality === "single" &&
              edgeDefinition.type === "ref") ||
            (edgeDefinition.cardinality === "multiple" &&
              edgeDefinition.type === "field")
          ) {
            if (idOrIds.remove !== undefined && idOrIds.remove.length > 0) {
              // Cascading delete because 1:many edges are not optional
              // on the stored field end.
              await Promise.all(
                idOrIds.remove.map((id) =>
                  this.deletedIdIn(
                    id,
                    edgeDefinition.to,
                    (deleteSoftly ?? false) &&
                      edgeDefinition.deletion === "soft",
                  ),
                ),
              );
              // This would be behavior for optional edge:
              // await Promise.all(
              //   idsToDelete.map((id) =>
              //     this.ctx.db.patch(id, {
              //       [edgeDefinition.ref]: undefined,
              //     } as any)
              //   )
              // );
            }
            if (idOrIds.add !== undefined && idOrIds.add.length > 0) {
              await Promise.all(
                idOrIds.add.map(async (id) =>
                  this.ctx.db.patch(id, {
                    [edgeDefinition.ref]: docId,
                  } as any),
                ),
              );
            }
          } else if (edgeDefinition.cardinality === "multiple") {
            if ((idOrIds.removeEdges ?? []).length > 0) {
              await Promise.all(
                idOrIds.removeEdges!.map(async (id) => {
                  try {
                    await this.ctx.db.delete(id);
                  } catch (e) {
                    // TODO:
                    // For now we're gonna ignore errors here,
                    // because we assume that the only error
                    // is "document not found", which
                    // can be caused by concurrent deletions.
                    // In the future we could track which
                    // edges are being deleted by this mutation,
                    // and skip the call to delete altogether
                    // - or Convex could implement this.
                  }
                }),
              );
            }

            if (idOrIds.add !== undefined) {
              await Promise.all(
                idOrIds.add.map(async (id) => {
                  const existing = await this.ctx.db
                    .query(edgeDefinition.table)
                    .withIndex(edgeDefinition.field, (q) =>
                      (q.eq(edgeDefinition.field, docId as any) as any).eq(
                        edgeDefinition.ref,
                        id,
                      ),
                    )
                    .first();
                  if (existing === null) {
                    await this.ctx.db.insert(edgeDefinition.table, {
                      [edgeDefinition.field]: docId,
                      [edgeDefinition.ref]: id,
                    } as any);
                    if (edgeDefinition.symmetric) {
                      await this.ctx.db.insert(edgeDefinition.table, {
                        [edgeDefinition.field]: id,
                        [edgeDefinition.ref]: docId,
                      } as any);
                    }
                  }
                }),
              );
            }
          }
        },
      ),
    );
  }

  async checkUniqueness(value: Partial<GenericDocument>, id?: GenericId<any>) {
    await Promise.all(
      Object.values(
        (this.entDefinitions[this.table] as any).fields as Record<
          string,
          FieldConfig
        >,
      ).map(async (fieldDefinition) => {
        if (fieldDefinition.unique) {
          const key = fieldDefinition.name;
          const fieldValue = value[key];
          const existing = await this.ctx.db
            .query(this.table)
            .withIndex(key, (q) => q.eq(key, value[key] as any))
            .unique();
          if (existing !== null && (id === undefined || existing._id !== id)) {
            throw new Error(
              `In table "${
                this.table
              }" cannot create a duplicate document with field "${key}" of value \`${
                fieldValue as string
              }\`, existing document with ID "${
                existing._id as string
              }" already has it.`,
            );
          }
        }
      }),
    );
    await Promise.all(
      Object.values(getEdgeDefinitions(this.entDefinitions, this.table)).map(
        async (edgeDefinition) => {
          if (
            edgeDefinition.cardinality === "single" &&
            edgeDefinition.type === "field" &&
            edgeDefinition.unique
          ) {
            const key = edgeDefinition.field;
            if (value[key] === undefined) {
              return;
            }
            // Enforce uniqueness
            const existing = await this.ctx.db
              .query(this.table)
              .withIndex(key, (q) => q.eq(key, value[key] as any))
              .unique();
            if (
              existing !== null &&
              (id === undefined || existing._id !== id)
            ) {
              throw new Error(
                `In table "${this.table}" cannot create a duplicate 1:1 edge "${
                  edgeDefinition.name
                }" to ID "${
                  value[key] as string
                }", existing document with ID "${
                  existing._id as string
                }" already has it.`,
              );
            }
          }
        },
      ),
    );
  }

  fieldsOnly(
    value: Partial<
      WithEdgePatches<
        DocumentByName<EntsDataModel, Table>,
        EntsDataModel[Table]["edges"]
      >
    >,
  ) {
    const fields: GenericDocument = {};
    Object.keys(value).forEach((key) => {
      const edgeDefinition = getEdgeDefinitions(
        this.entDefinitions,
        this.table,
      )[key];
      if (
        edgeDefinition === undefined
        // This doesn't do anything because the edge name doesn't match the field name
        //  ||
        // (edgeDefinition.cardinality === "single" &&
        //   edgeDefinition.type === "field")
      ) {
        fields[key] = value[key]!;
      }
    });
    return fields;
  }

  async checkReadAndWriteRule(
    operation: "create" | "update" | "delete",
    id: GenericId<Table> | undefined,
    value: Partial<GenericDocument> | undefined,
  ) {
    if (id !== undefined) {
      const readPolicy = getReadRule(this.entDefinitions, this.table);
      if (readPolicy !== undefined) {
        const doc = await this.ctx.db.get(id);
        if (doc === null) {
          throw new Error(
            `Cannot update document with ID "${id}" in table "${this.table} because it does not exist"`,
          );
        }
        const decision = await readPolicy(doc);
        if (!decision) {
          throw new Error(
            `Cannot update document with ID "${id}" from table "${this.table}"`,
          );
        }
      }
    }
    const writePolicy = getWriteRule(this.entDefinitions, this.table);
    if (writePolicy === undefined) {
      return;
    }
    const ent =
      id === undefined
        ? undefined
        : entWrapper(
            (await this.ctx.db.get(id))!,
            this.ctx,
            this.entDefinitions,
            this.table,
          );
    // Replace allows _id and _creationTime, but rules should not
    // rely on them.
    const { _id, _creationTime, ...safeValue } = value ?? {};
    const decision = await writePolicy({
      operation,
      ent: ent as any,
      value: value !== undefined ? (safeValue as any) : undefined,
    });
    if (!decision) {
      if (id === undefined) {
        throw new Error(
          `Cannot insert into table "${this.table}": \`${JSON.stringify(
            value,
          )}\``,
        );
      } else if (value === undefined) {
        throw new Error(
          `Cannot delete from table "${this.table}" with ID "${id}"`,
        );
      } else {
        throw new Error(
          `Cannot update document with ID "${id}" in table "${
            this.table
          }" with: \`${JSON.stringify(value)}\``,
        );
      }
    }
  }
}

export type WithEdgeInserts<
  Document extends GenericDocument,
  Edges extends Record<string, GenericEdgeConfig>,
> = Document & {
  [key in keyof Edges as Edges[key]["cardinality"] extends "single"
    ? Edges[key]["type"] extends "field"
      ? never
      : key
    : key]?: Edges[key]["cardinality"] extends "single"
    ? GenericId<Edges[key]["to"]>
    : GenericId<Edges[key]["to"]>[];
};

export type WithEdges<
  Document extends GenericDocument,
  Edges extends Record<string, GenericEdgeConfig>,
> = Document & {
  [key in keyof Edges as Edges[key]["cardinality"] extends "multiple"
    ? Edges[key]["type"] extends "ref"
      ? key
      : never
    : never]?: GenericId<Edges[key]["to"]>[];
};

export type WithEdgePatches<
  Document extends GenericDocument,
  Edges extends Record<string, GenericEdgeConfig>,
> = Document & {
  [key in keyof Edges as Edges[key]["cardinality"] extends "multiple"
    ? Edges[key]["type"] extends "ref"
      ? key
      : never
    : never]?: {
    add?: GenericId<Edges[key]["to"]>[];
    remove?: GenericId<Edges[key]["to"]>[];
  };
};

export type EdgeChanges = Record<
  string,
  {
    add?: GenericId<any>[];
    remove?: GenericId<any>[];
    removeEdges?: GenericId<any>[];
  }
>;
