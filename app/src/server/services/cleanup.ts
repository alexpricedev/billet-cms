import { ensureIdentitiesView } from "../database/identity-view";
import { cleanupExpiredMcpCredentials } from "../mcp/oauth/tokens";
import { cleanupExpired } from "./auth";
import { log } from "./logger";

// Hourly. Nothing reads an expired row — every query filters on `expires_at` —
// so the sweep is never on a correctness path and the schedule only trades disk
// and retention window against write load.
const SWEEP_SCHEDULE = "0 * * * *";

/**
 * Delete every expired row the CMS owns, and re-ensure the identity view.
 *
 * The view is created at boot only when missing, and a site migration drops it
 * to retype a pinned `users` column (Postgres refuses the change while it
 * depends on it). Rebuilding it here means sign-in recovers within the hour
 * rather than waiting for a restart.
 */
export const runCleanupSweep = async (): Promise<void> => {
  await cleanupExpired();
  await cleanupExpiredMcpCredentials();
  await ensureIdentitiesView();
};

// A rejection escaping a cron callback is an unhandled rejection, which
// Bun treats as fatal — a transient database blip during a sweep would take the
// server down. Swallow it and try again next hour.
const sweep = async (): Promise<void> => {
  try {
    await runCleanupSweep();
  } catch (error) {
    log.error(
      "cleanup",
      `Sweep failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/**
 * Start the periodic sweep, returning a stop handle.
 *
 * Runs once immediately, and is deliberately not awaited by the caller — boot
 * must not wait on a DELETE.
 */
export const startCleanupSweep = (): (() => void) => {
  void sweep();

  const job = Bun.cron(SWEEP_SCHEDULE, sweep, { tz: "UTC" }).unref();

  return () => {
    job.stop();
  };
};
