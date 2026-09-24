import { defineSchema } from "convex/server";
import { authorizationRequestsTable, ticketsTable } from "../shared/schema.ts";

export default defineSchema({
  authorizationRequests: authorizationRequestsTable,
  tickets: ticketsTable,
});
