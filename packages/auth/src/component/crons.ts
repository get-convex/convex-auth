/**
 * Component-internal scheduled jobs.
 *
 * @module
 */

import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

crons.daily(
  "auth-prune-expired",
  { hourUTC: 3, minuteUTC: 0 },
  internal.maintenance.pruneExpired,
  {},
);

/**
 * Hard-delete revoked OAuth clients (batch-limited, oldest-first) so dynamic
 * client registration (RFC 7591) does not grow the `OAuthClient` table without
 * bound. Revoked clients are already rejected at every use; this reclaims them.
 */
crons.daily(
  "auth-prune-oauth-clients",
  { hourUTC: 3, minuteUTC: 30 },
  internal.oauth.client.prune,
  {},
);

/**
 * Feed newly-projected auth events into the durable stream. The drainer
 * self-reschedules while a backlog remains, so this interval is a periodic kick
 * (and recovery if a chain ever dies), not the steady-state cadence.
 */
crons.interval("auth-drain-events", { minutes: 1 }, internal.event.drainPending, {});

export default crons;
