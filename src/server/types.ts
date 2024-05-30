import { Provider as AuthProvider } from "@auth/core/providers";
import { Theme } from "@auth/core/types";
import { GenericActionCtx, GenericDataModel } from "convex/server";

export type ConvexAuthConfig = {
  providers: AuthProvider[];
  theme?: Theme;
  session?: {
    /**
     * How long can a user session last without the user reauthenticating.
     *
     * Defaults to 30 days.
     */
    totalDurationMs?: number;
    /**
     * How long can a user session last without the user being active.
     *
     * Defaults to 30 days.
     */
    inactiveDurationMs?: number;
  };
  jwt?: {
    /**
     * How long is the JWT valid for after it is signed initially.
     *
     * Defaults to 1 hour.
     */
    durationMs?: number;
  };
};

export type GenericActionCtxWithAuthConfig<DataModel extends GenericDataModel> =
  GenericActionCtx<DataModel> & { auth: { config: ConvexAuthConfig } };
