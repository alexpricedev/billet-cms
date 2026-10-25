import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  applyPreview,
  getPreviewAccess,
  hashPreviewToken,
  PREVIEW_BANNER_ID,
  PREVIEW_HEADERS,
  PREVIEW_QUERY_PARAM,
  readPreviewAccess,
  renderPreviewBanner,
} from "./index";

/** A pool whose only table is a map of token hash to subject. */
const fakeSql = (
  tokens: Record<string, { subject_type: "page" | "slot"; subject_id: string }>,
) => {
  const sql = {
    unsafe: (query: string, params: unknown[] = []) => {
      if (!query.includes("cms_preview_tokens")) return Promise.resolve([]);
      const hash = params[0] as string;
      const row = tokens[hash];
      return Promise.resolve(row ? [row] : []);
    },
  } as unknown as SQL;
  return sql;
};

describe("hashPreviewToken", () => {
  test("is a stable hex digest of the raw token", () => {
    const hash = hashPreviewToken("raw-token");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPreviewToken("raw-token")).toBe(hash);
    expect(hashPreviewToken("another")).not.toBe(hash);
  });
});

describe("readPreviewAccess", () => {
  test("returns the subject a live token covers", async () => {
    const sql = fakeSql({
      [hashPreviewToken("good")]: { subject_type: "page", subject_id: "p-1" },
    });

    expect(await readPreviewAccess(sql, "good")).toEqual({
      subjectType: "page",
      subjectId: "p-1",
    });
  });

  test("returns null for an unknown token", async () => {
    const sql = fakeSql({
      [hashPreviewToken("good")]: { subject_type: "slot", subject_id: "s-1" },
    });

    expect(await readPreviewAccess(sql, "wrong")).toBeNull();
  });

  // Expiry is applied in the query against the bound clock, so a test can
  // present an expired token without waiting for its own clock to move.
  test("passes the presented time as the expiry boundary", async () => {
    let seen: Date | null = null;
    const sql = {
      unsafe: (_query: string, params: unknown[] = []) => {
        seen = params[1] as Date;
        return Promise.resolve([]);
      },
    } as unknown as SQL;

    const now = new Date("2026-10-13T12:00:00.000Z");
    await readPreviewAccess(sql, "token", now);
    expect(seen as Date | null).toEqual(now);
  });

  test("answers nothing for an expired token", async () => {
    // The fake enforces the same rule as the query: the row exists, but the
    // boundary is past its expiry, so it is not returned.
    const sql = {
      unsafe: (_query: string, params: unknown[] = []) => {
        const expiresAt = new Date("2026-10-13T11:00:00.000Z");
        const now = params[1] as Date;
        return Promise.resolve(
          now > expiresAt ? [] : [{ subject_type: "page", subject_id: "p-1" }],
        );
      },
    } as unknown as SQL;

    expect(
      await readPreviewAccess(sql, "token", new Date("2026-10-13T11:30:00Z")),
    ).toBeNull();
    expect(
      await readPreviewAccess(sql, "token", new Date("2026-10-13T10:30:00Z")),
    ).toEqual({ subjectType: "page", subjectId: "p-1" });
  });
});

describe("getPreviewAccess", () => {
  const sql = fakeSql({
    [hashPreviewToken("good")]: { subject_type: "slot", subject_id: "s-1" },
  });

  test("reads the token from the query string", async () => {
    const req = new Request(
      `http://site.test/about?${PREVIEW_QUERY_PARAM}=good`,
    );
    expect(await getPreviewAccess(sql, req)).toEqual({
      subjectType: "slot",
      subjectId: "s-1",
    });
  });

  test("is null without the parameter, and for a wrong token", async () => {
    expect(
      await getPreviewAccess(sql, new Request("http://site.test/about")),
    ).toBeNull();
    expect(
      await getPreviewAccess(
        sql,
        new Request(`http://site.test/about?${PREVIEW_QUERY_PARAM}=wrong`),
      ),
    ).toBeNull();
  });

  test("falls back to the published view when the check throws", async () => {
    const skipped: string[] = [];
    const throwing = {
      unsafe: () => {
        throw new Error('relation "cms_preview_tokens" does not exist');
      },
    } as unknown as SQL;

    const access = await getPreviewAccess(
      throwing,
      new Request(`http://site.test/?${PREVIEW_QUERY_PARAM}=good`),
      { onSkip: (message) => skipped.push(message) },
    );

    expect(access).toBeNull();
    expect(skipped.some((line) => line.includes("preview token"))).toBe(true);
  });
});

describe("applyPreview", () => {
  const access = { subjectType: "page" as const, subjectId: "p-1" };

  test("leaves a response untouched without access", async () => {
    const response = new Response("plain", {
      headers: { "Content-Type": "text/html" },
    });
    const same = await applyPreview(response, null);
    expect(same).toBe(response);
  });

  test("adds no-store and noindex to any preview response", async () => {
    const response = new Response("{}", {
      headers: { "Content-Type": "application/json" },
    });
    const previewed = await applyPreview(response, access);

    expect(previewed.headers.get("Cache-Control")).toBe(
      PREVIEW_HEADERS["Cache-Control"],
    );
    expect(previewed.headers.get("X-Robots-Tag")).toBe(
      PREVIEW_HEADERS["X-Robots-Tag"],
    );
    expect(await previewed.text()).toBe("{}");
  });

  test("sends no referrer, so the token URL never reaches a subresource", async () => {
    // The preview URL carries the raw token; a third-party subresource must not
    // learn it through the Referer header (or through any page the draft links
    // out to).
    const response = new Response(
      "<html><body><img src='/x.png'></body></html>",
      {
        headers: { "Content-Type": "text/html" },
      },
    );
    const previewed = await applyPreview(response, access);

    expect(previewed.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  test("injects the banner into an HTML body", async () => {
    const response = new Response("<html><body><h1>Hi</h1></body></html>", {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
    const previewed = await applyPreview(response, access);
    const html = await previewed.text();

    expect(html).toContain(`id="${PREVIEW_BANNER_ID}"`);
    expect(html).toContain("<h1>Hi</h1>");
    expect(html.indexOf(PREVIEW_BANNER_ID)).toBeLessThan(
      html.indexOf("</body>"),
    );
  });

  test("is a labelled region, sticky so it never covers the site header", () => {
    const banner = renderPreviewBanner();

    expect(banner).toContain('role="region"');
    expect(banner).toContain('aria-label="Preview"');
    expect(banner).not.toContain('role="status"');
    expect(banner).toContain("position:sticky;top:0");
  });

  test("links back to the slot's editor when CMS_URL is known", () => {
    const banner = renderPreviewBanner(
      { subjectType: "slot", subjectId: "s-1" },
      "https://cms.example.com/",
    );

    expect(banner).toContain('href="https://cms.example.com/cms/slots/s-1"');
    expect(banner).toContain("Back to the editor");
  });

  test("links back to the page's editor for a page preview", () => {
    const banner = renderPreviewBanner(
      { subjectType: "page", subjectId: "p-1" },
      "https://cms.example.com",
    );

    expect(banner).toContain('href="https://cms.example.com/cms/pages/p-1"');
  });

  test("has no link without a usable CMS_URL or without access", () => {
    const slot = { subjectType: "slot", subjectId: "s-1" } as const;

    expect(renderPreviewBanner(slot, undefined)).not.toContain("<a ");
    expect(renderPreviewBanner(slot, "javascript:alert(1)")).not.toContain("<a ");
    expect(renderPreviewBanner(slot, "not a url")).not.toContain("<a ");
    expect(renderPreviewBanner(null, "https://cms.example.com")).not.toContain(
      "<a ",
    );
  });

  test("encodes the subject id so it cannot break out of the attribute", () => {
    const banner = renderPreviewBanner(
      { subjectType: "slot", subjectId: '"><script>x</script>' },
      "https://cms.example.com",
    );

    expect(banner).not.toContain("<script>");
    expect(banner).toContain("%22%3E%3Cscript%3E");
  });

  test("injects the banner as the first child of the body", async () => {
    const response = new Response(
      "<html><head><title>x</title></head><body><header>H</header></body></html>",
      { headers: { "Content-Type": "text/html" } },
    );
    const html = await (await applyPreview(response, access)).text();

    // Before the site's own header, so sticky keeps it at the top of the flow
    // instead of a fixed banner covering that header.
    expect(html.indexOf(PREVIEW_BANNER_ID)).toBeGreaterThan(
      html.indexOf("<body>"),
    );
    expect(html.indexOf(PREVIEW_BANNER_ID)).toBeLessThan(
      html.indexOf("<header>"),
    );
  });

  test("matches the body tag whatever case it is written in", async () => {
    const response = new Response("<HTML><BODY><h1>Hi</h1></BODY></HTML>", {
      headers: { "Content-Type": "text/html" },
    });
    const html = await (await applyPreview(response, access)).text();

    expect(html.indexOf(PREVIEW_BANNER_ID)).toBeLessThan(
      html.indexOf("<h1>Hi</h1>"),
    );
  });

  test("does not mistake a <body-something> element for the body", async () => {
    // `/<body[^>]*>/` matched this custom element and put the banner inside it;
    // the tightened regex requires `>` or whitespace after `<body`.
    const response = new Response(
      "<html><body-guard><h1>Hi</h1></body-guard><body><p>content</p></body></html>",
      { headers: { "Content-Type": "text/html" } },
    );
    const html = await (await applyPreview(response, access)).text();

    expect(html.indexOf(PREVIEW_BANNER_ID)).toBeGreaterThan(
      html.indexOf("<body-guard>"),
    );
    expect(html.indexOf(PREVIEW_BANNER_ID)).toBeLessThan(
      html.indexOf("<p>content</p>"),
    );
  });

  test("appends the banner when there is no body tag", async () => {
    const response = new Response("<p>Fragment</p>", {
      headers: { "Content-Type": "text/html" },
    });
    const html = await (await applyPreview(response, access)).text();

    // Appended, not prepended: an insertion ahead of the document would land
    // before `<!doctype html>` and force quirks mode.
    expect(html).toBe(`<p>Fragment</p>${renderPreviewBanner(access, undefined)}`);
  });

  test("is not fooled by a </body> spelled inside a script", async () => {
    const source =
      '<html><body><script>const s = "</body>";</script><h1>Hi</h1></body></html>';
    const response = new Response(source, {
      headers: { "Content-Type": "text/html" },
    });
    const html = await (await applyPreview(response, access)).text();

    // The banner goes right after `<body>`, not where the script's string
    // happens to spell the closing tag.
    expect(html.indexOf(PREVIEW_BANNER_ID)).toBeLessThan(
      html.indexOf("<script>"),
    );
    expect(html).toContain('<script>const s = "</body>";</script>');
  });

  test("strips the framing headers it invalidates", async () => {
    const response = new Response("<html><body><h1>Hi</h1></body></html>", {
      headers: {
        "Content-Type": "text/html",
        "Content-Length": "999",
        ETag: 'W/"stale"',
      },
    });
    const previewed = await applyPreview(response, access);

    expect(previewed.headers.get("Content-Length")).toBeNull();
    expect(previewed.headers.get("ETag")).toBeNull();
  });

  test("leaves an already-encoded body alone, headers only", async () => {
    const encoded = Bun.gzipSync(
      new TextEncoder().encode("<html><body><h1>Hi</h1></body></html>"),
    );
    const response = new Response(encoded, {
      headers: {
        "Content-Type": "text/html",
        "Content-Encoding": "gzip",
        "Content-Length": String(encoded.byteLength),
        ETag: 'W/"stale"',
      },
    });
    const previewed = await applyPreview(response, access);

    // The headers say no-cache, noindex — but reading the compressed bytes as
    // text would corrupt the page, so the body and its encoding are untouched.
    expect(previewed.headers.get("Cache-Control")).toBe("no-store");
    expect(previewed.headers.get("Content-Encoding")).toBe("gzip");
    expect(previewed.headers.get("Content-Length")).toBe(
      String(encoded.byteLength),
    );
    expect(previewed.headers.get("ETag")).toBeNull();
    expect(new Uint8Array(await previewed.arrayBuffer())).toEqual(encoded);
  });
});
