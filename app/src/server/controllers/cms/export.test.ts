import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createBunRequest } from "../../test-utils/bun-request";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData, seedIdentity } from "../../test-utils/helpers";

const connection = testDatabase();

mock.module("../../services/database", () => ({
  get db() {
    return connection;
  },
}));

import { createCsrfToken } from "../../services/csrf";
import { db } from "../../services/database";
import { listExportTokens } from "../../services/export";
import { createAuthenticatedSession } from "../../services/sessions";
import { exportTokens } from "./export";

const ORIGIN = process.env.APP_URL as string;

describe("Export tokens controller", () => {
  let editorId: string;
  let sessionId: string;

  beforeEach(async () => {
    await cleanupTestData(db);
    editorId = (await seedIdentity(db, "editor@example.com")).id;
    sessionId = await createAuthenticatedSession(editorId);
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  const get = (path: string) =>
    createBunRequest(`${ORIGIN}${path}`, {
      method: "GET",
      headers: { cookie: `cms_session=${sessionId}` },
    });

  const post = async (
    path: string,
    body: FormData,
    csrfPath: string,
    params: Record<string, string> = {},
  ) => {
    body.set("_csrf", await createCsrfToken(sessionId, "POST", csrfPath));
    return createBunRequest(
      `${ORIGIN}${path}`,
      {
        method: "POST",
        headers: { Origin: ORIGIN, cookie: `cms_session=${sessionId}` },
        body,
      },
      params,
    );
  };

  test("redirects an anonymous visitor to sign in", async () => {
    const res = await exportTokens.index(
      createBunRequest(`${ORIGIN}/cms/export`, { method: "GET" }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sign-in");
  });

  test("lists tokens, creates one showing the raw value once, and revokes it", async () => {
    const empty = await exportTokens.index(get("/cms/export"));
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("No export tokens yet");

    const form = new FormData();
    form.set("label", "Alex's laptop");
    const created = await exportTokens.create(
      await post("/cms/export", form, "/cms/export"),
    );
    expect(created.status).toBe(200);
    // The raw token is in this body; it must never sit in a cache.
    expect(created.headers.get("cache-control")).toBe("no-store");
    const createdHtml = await created.text();
    expect(createdHtml).toContain("Copy this token now");
    const raw = createdHtml.match(
      /data-export-token(?:="[^"]*")?>([^<]+)</,
    )?.[1];
    expect(raw).toBeTruthy();

    // A fresh list does not carry the raw value: it is shown once.
    const list = await exportTokens.index(get("/cms/export"));
    const listHtml = await list.text();
    expect(listHtml).toContain("Alex's laptop");
    expect(listHtml).not.toContain(raw as string);
    // Each Revoke button names the token it revokes, and the help text is both
    // styled and wired to the input it describes.
    expect(listHtml).toContain('aria-label="Revoke ');
    // Revoke asks first, naming the token.
    expect(listHtml).toContain(
      "data-confirm-title=\"Revoke 'Alex's laptop'?\"",
    );
    expect(listHtml).toContain('data-confirm-label="Revoke"');
    expect(listHtml).toContain('aria-describedby="export-label-help"');
    expect(listHtml).toContain('class="cms-field-help"');

    const [token] = await listExportTokens();
    const revoked = await exportTokens.revoke(
      await post(
        `/cms/export/${token.id}/revoke`,
        new FormData(),
        `/cms/export/${token.id}/revoke`,
        { id: token.id },
      ),
    );
    expect(revoked.status).toBe(303);
    expect(revoked.headers.get("location")).toBe("/cms/export?revoked=1");

    const after = await listExportTokens();
    expect(after[0].revokedAt).not.toBeNull();
  });

  test("refuses a token with no name", async () => {
    const form = new FormData();
    form.set("label", "   ");
    const res = await exportTokens.create(
      await post("/cms/export", form, "/cms/export"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Name this token");
  });

  test("refuses a label over 100 characters", async () => {
    const form = new FormData();
    form.set("label", "x".repeat(101));
    const res = await exportTokens.create(
      await post("/cms/export", form, "/cms/export"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Use 100 characters or fewer.");

    // Nothing was written: the length is checked before the insert.
    expect(await listExportTokens()).toHaveLength(0);
  });
});
