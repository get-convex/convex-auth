import {
  DocumentByName,
  FunctionReference,
  GenericDataModel,
  RegisteredAction,
  RegisteredMutation,
  RegisteredQuery,
  TableNamesInDataModel,
} from "convex/server";
import { GenericId } from "convex/values";

type UndefinedToNull<T> = T extends void ? null : T;

export type MutationRef<T> =
  T extends RegisteredMutation<infer Visibility, infer Args, infer Output>
    ? FunctionReference<
        "mutation",
        Visibility,
        Args,
        UndefinedToNull<Awaited<Output>>
      >
    : never;

export type GenericDoc<
  DataModel extends GenericDataModel,
  TableName extends TableNamesInDataModel<DataModel>,
> = DocumentByName<DataModel, TableName> & {
  _id: GenericId<TableName>;
  _creationTime: number;
};

export type FunctionReferenceFromExport<Export> =
  Export extends RegisteredQuery<infer Visibility, infer Args, infer Output>
    ? FunctionReference<"query", Visibility, Args, ConvertReturnType<Output>>
    : Export extends RegisteredMutation<
          infer Visibility,
          infer Args,
          infer Output
        >
      ? FunctionReference<
          "mutation",
          Visibility,
          Args,
          ConvertReturnType<Output>
        >
      : Export extends RegisteredAction<
            infer Visibility,
            infer Args,
            infer Output
          >
        ? FunctionReference<
            "action",
            Visibility,
            Args,
            ConvertReturnType<Output>
          >
        : never;

type ConvertReturnType<T> = UndefinedToNull<Awaited<T>>;
