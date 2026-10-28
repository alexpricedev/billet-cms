/**
 * The MCP spike's environment.
 *
 * This is deliberately a development seam, not a product surface: there is no
 * OAuth yet, so the only credential the endpoint accepts is a single bearer
 * token from the environment. `validateEnv` refuses to boot with MCP enabled in
 * production, and refuses to boot with MCP enabled and no token, so the spike
 * can never become an unauthenticated production endpoint by accident.
 *
 * Read at call time rather than module load: tests set these on the process.
 */

/** Whether `/mcp` answers at all. Off unless explicitly `true`. */
export const isMcpEnabled = (): boolean => process.env.MCP_ENABLED === "true";

/** The one bearer token the spike accepts. `null` when unset. */
export const mcpDevToken = (): string | null => {
  const value = process.env.MCP_DEV_TOKEN?.trim();
  return value ? value : null;
};

/**
 * The `cms_identities` email the dev token acts as.
 *
 * Optional: without it the spike can still read, but a write has no `created_by`
 * and `get_profile` has no identity to report. Set it to a fixture admin (for
 * example `priya@example.com`) to exercise history and attribution.
 */
export const mcpDevIdentityEmail = (): string | null => {
  const value = process.env.MCP_DEV_IDENTITY_EMAIL?.trim();
  return value ? value.toLowerCase() : null;
};
