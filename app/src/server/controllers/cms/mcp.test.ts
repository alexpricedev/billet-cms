import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData, seedIdentity } from "../../test-utils/helpers";

const connection = testDatabase();

mock.module("../../services/database", () => ({
  get db() {
    return connection;
  },
}));

import { registerClient } from "../../mcp/oauth/clients";
import { createOrReuseGrant, getGrantById } from "../../mcp/oauth/tokens";
import { createCsrfToken } from "../../services/csrf";
import { db } from "../../services/database";
import { createAuthenticatedSession } from "../../services/sessions";
import { createBunRequest } from "../../test-utils/bun-request";
import { connectedApps } from "./mcp";

const ORIGIN = process.env.APP_URL as string;
const COOKIE = "cms_session";

let session: string;
let grantId: string;
const originalMcpEnabled = process.env.MCP_ENABLED;

beforeEach(async () => {
  process.env.MCP_ENABLED = "true";
  await cleanupTestData(db);
  const identity = await seedIdentity(db, "editor@example.com");
  const client = await registerClient({
    client_name: "Claude Code (billet)",
    redirect_uris: ["http://localhost:9999/callback"],
  });
  if (!client.ok) throw new Error(client.description);

  const grant = await createOrReuseGrant({
    clientId: client.client.clientId,
    identityId: identity.id,
  });
  grantId = grant.id;
  session = await createAuthenticatedSession(identity.id);
});

afterAll(async () => {
  await connection.end();
  if (originalMcpEnabled === undefined) {
    delete process.env.MCP_ENABLED;
  } else {
    process.env.MCP_ENABLED = originalMcpEnabled;
  }
  mock.restore();
});

const get = (url: string, withSession = true) =>
  createBunRequest(`${ORIGIN}${url}`, {
    method: "GET",
    headers: withSession ? { cookie: `${COOKIE}=${session}` } : {},
  });

const revoke = (id: string, csrf: string) =>
  createBunRequest(
    `${ORIGIN}/cms/mcp/${id}/revoke`,
    {
      method: "POST",
      headers: {
        cookie: `${COOKIE}=${session}`,
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    },
    { id },
  );

describe("Connected apps controller", () => {
  test("is a 404 when the MCP endpoint is disabled", async () => {
    process.env.MCP_ENABLED = "false";
    const response = await connectedApps.index(get("/cms/mcp"));
    expect(response.status).toBe(404);
  });

  test("redirects a signed-out visitor to sign in", async () => {
    const response = await connectedApps.index(get("/cms/mcp", false));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sign-in");
  });

  test("lists the grant with its client, person and revoke control", async () => {
    const response = await connectedApps.index(get("/cms/mcp"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Claude Code (billet)");
    expect(body).toContain("editor@example.com");
    expect(body).toContain(`/cms/mcp/${grantId}/revoke`);
    expect(body).toContain("Disconnect");
  });

  test("revokes the grant and keeps it as history", async () => {
    const csrf = await createCsrfToken(
      session,
      "POST",
      `/cms/mcp/${grantId}/revoke`,
    );
    const response = await connectedApps.revoke(revoke(grantId, csrf));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/cms/mcp?revoked=1");
    expect((await getGrantById(grantId))?.revokedAt).not.toBeNull();

    const page = await (
      await connectedApps.index(get("/cms/mcp?revoked=1"))
    ).text();
    expect(page).toContain("Disconnected");
    expect(page).toContain("App disconnected.");
  });

  test("a bad CSRF token revokes nothing", async () => {
    const response = await connectedApps.revoke(revoke(grantId, "wrong"));
    expect(response.status).toBe(403);
    expect((await getGrantById(grantId))?.revokedAt).toBeNull();
  });

  test("an unknown grant is a 404", async () => {
    const csrf = await createCsrfToken(
      session,
      "POST",
      "/cms/mcp/00000000-0000-4000-8000-000000000099/revoke",
    );
    const response = await connectedApps.revoke(
      revoke("00000000-0000-4000-8000-000000000099", csrf),
    );
    expect(response.status).toBe(404);
  });
});
