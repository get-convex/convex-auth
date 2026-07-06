import { customAction, customMutation, customQuery } from "convex-helpers/server/customFunctions";

import { action, mutation, query } from "./_generated/server";
import { auth } from "./auth/core";

const authCtx = auth.ctx();

export const authQuery = customQuery(query, authCtx);
export const authMutation = customMutation(mutation, authCtx);
export const authAction = customAction(action, authCtx);

export const authUserQuery = authQuery;
export const authUserMutation = authMutation;
export const authUserAction = authAction;
