import { afterEach, describe, expect, test } from "bun:test";
import { SITE_NAME } from "../services/seo";
import { createBunRequest } from "../test-utils/bun-request";
import {
  handleGuarded,
  SECURITY_HEADERS,
  secureRoutes,
  withSecurityHeaders,
} from "./security-headers";

describe("X-Robots-Tag", () => {
  afterEach(() => {
    delete process.env.ALLOW_INDEXING;
  });

  // The header as well as the meta tag: an image, the sitemap, llms.txt and
  // every JSON response is indexable on its own and has nowhere to put a
  // <meta>. This is the layer with no gaps.
  test("blocks indexing on every response by default", () => {
    const res = withSecurityHeaders(new Response("ok"));

    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  test("stops blocking once indexing is switched on", () => {
    process.env.ALLOW_INDEXING = "true";

    const res = withSecurityHeaders(new Response("ok"));

    expect(res.headers.get("X-Robots-Tag")).toBeNull();
  });

  test("leaves a route's own X-Robots-Tag alone", () => {
    const res = withSecurityHeaders(
      new Response("ok", { headers: { "X-Robots-Tag": "noarchive" } }),
    );

    expect(res.headers.get("X-Robots-Tag")).toBe("noarchive");
  });
});

describe("Content-Security-Policy script-src", () => {
  // The Lottie player was the CMS's only third-party script; it loaded from
  // unpkg, so dropping it is what lets the CDN host leave `script-src`. A
  // re-added CDN script passes every other test and is blocked only in a real
  // browser, so pin the absence here too (the smoke tests catch the opposite
  // mistake: a first-party script the policy accidentally blocks).
  test("allows only first-party scripts", () => {
    const csp =
      withSecurityHeaders(new Response("ok")).headers.get(
        "Content-Security-Policy",
      ) ?? "";

    expect(csp.split("; ")).toContain("script-src 'self'");
    expect(csp).not.toContain("unpkg.com");
    expect(csp).not.toContain("https://");
  });

  // The JSON-LD block is a data block CSP does not check, so nothing needs
  // inline script execution. `style-src` keeps its own 'unsafe-inline'.
  test("does not allow inline scripts", () => {
    const csp =
      withSecurityHeaders(new Response("ok")).headers.get(
        "Content-Security-Policy",
      ) ?? "";
    const scriptSrc = csp
      .split("; ")
      .find((directive) => directive.startsWith("script-src "));

    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });
});

describe("Content-Security-Policy img-src", () => {
  afterEach(() => {
    delete process.env.MEDIA_PUBLIC_BASE_URL;
  });

  // The uploaded images are served from the bucket, not the CMS host, so
  // without this every thumbnail and focal preview is blocked by the CMS's own
  // CSP (review r1-2).
  test("allows the bucket's origin when one is configured", () => {
    process.env.MEDIA_PUBLIC_BASE_URL = "https://bucket.railway.app/media";
    const csp =
      withSecurityHeaders(new Response("ok")).headers.get(
        "Content-Security-Policy",
      ) ?? "";

    expect(csp).toContain("img-src 'self' data: https://bucket.railway.app");
  });

  test("falls back to the CMS host when the bucket isn't configured", () => {
    const csp =
      withSecurityHeaders(new Response("ok")).headers.get(
        "Content-Security-Policy",
      ) ?? "";

    expect(csp).toContain("img-src 'self' data:;");
  });

  test("ignores a base URL that isn't a valid origin", () => {
    process.env.MEDIA_PUBLIC_BASE_URL = "not a url";
    const csp =
      withSecurityHeaders(new Response("ok")).headers.get(
        "Content-Security-Policy",
      ) ?? "";

    expect(csp).toContain("img-src 'self' data:;");
  });

  test("ignores a base URL whose scheme isn't http(s)", () => {
    // `new URL("ftp://bucket.example").origin` is a real string and would land
    // in `img-src`; `data:`/`javascript:` report "null". Only http(s) is an
    // origin a page can load.
    for (const value of [
      "ftp://bucket.example/media",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
    ]) {
      process.env.MEDIA_PUBLIC_BASE_URL = value;
      const csp =
        withSecurityHeaders(new Response("ok")).headers.get(
          "Content-Security-Policy",
        ) ?? "";

      expect(csp).toContain("img-src 'self' data:;");
    }
  });
});

describe("withSecurityHeaders", () => {
  test("adds the core security headers to a bare response", () => {
    const res = withSecurityHeaders(new Response("ok"));

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(res.headers.get("Permissions-Policy")).toContain("camera=()");
  });

  test("sets a Content-Security-Policy with clickjacking directives", () => {
    const res = withSecurityHeaders(new Response("ok"));
    const csp = res.headers.get("Content-Security-Policy") ?? "";

    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  test("omits upgrade-insecure-requests outside production", () => {
    // Production-only for the same reason as HSTS below — and unlike Chrome,
    // WebKit upgrades http://localhost subresources too, so shipping it in dev
    // strips every asset off the page under the browser smoke tests.
    const res = withSecurityHeaders(new Response("ok"));
    const csp = res.headers.get("Content-Security-Policy") ?? "";

    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  test("advertises discovery resources via a Link header", () => {
    const res = withSecurityHeaders(new Response("ok"));
    const link = res.headers.get("Link") ?? "";

    expect(link).toContain('</llms.txt>; rel="describedby"');
    expect(link).toContain('</sitemap.xml>; rel="sitemap"');
    expect(link).toContain('</.well-known/security.txt>; rel="security"');
  });

  test("does not clobber a Link header a response already set", () => {
    const res = withSecurityHeaders(
      new Response("ok", { headers: { Link: "<https://x.test>; rel=next" } }),
    );

    expect(res.headers.get("Link")).toBe("<https://x.test>; rel=next");
  });

  test("does not clobber headers a response already set", () => {
    const res = withSecurityHeaders(
      new Response("ok", {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60",
        },
      }),
    );

    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("omits HSTS outside production", () => {
    // Tests run with NODE_ENV=test, so the strict-transport header is withheld
    // to avoid pinning localhost to HTTPS.
    expect(SECURITY_HEADERS["Strict-Transport-Security"]).toBeUndefined();
  });

  test("signs a redirect with X-Redirect-By", () => {
    const res = withSecurityHeaders(
      new Response(null, { status: 308, headers: { Location: "/canonical" } }),
    );

    expect(res.headers.get("X-Redirect-By")).toBe(SITE_NAME);
  });

  test("does not add X-Redirect-By to a non-redirect response", () => {
    const res = withSecurityHeaders(new Response("ok"));

    expect(res.headers.get("X-Redirect-By")).toBeNull();
  });
});

describe("handleGuarded", () => {
  test("serves a styled 500 without leaking the error when the producer throws", async () => {
    const req = createBunRequest("http://localhost:3000/boom");
    const res = await handleGuarded(req, () => {
      throw new Error("db exploded at /secret/path.ts:42");
    });

    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Something went wrong");
    expect(body).not.toContain("db exploded");
    // Still runs through the header pipeline.
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("passes a successful response through unchanged", async () => {
    const req = createBunRequest("http://localhost:3000/ok");
    const res = await handleGuarded(req, () => new Response("hi"));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hi");
  });

  test("serves a 503 with Retry-After when maintenance mode is on", async () => {
    const previous = process.env.MAINTENANCE_MODE;
    process.env.MAINTENANCE_MODE = "true";
    try {
      const req = createBunRequest("http://localhost:3000/anything");
      const res = await handleGuarded(
        req,
        () => new Response("should not run"),
      );

      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("3600");
      expect(await res.text()).toContain("be right back");
    } finally {
      if (previous === undefined) {
        delete process.env.MAINTENANCE_MODE;
      } else {
        process.env.MAINTENANCE_MODE = previous;
      }
    }
  });

  test("keeps the health check alive during maintenance", async () => {
    const previous = process.env.MAINTENANCE_MODE;
    process.env.MAINTENANCE_MODE = "true";
    try {
      const req = createBunRequest("http://localhost:3000/health");
      const res = await handleGuarded(
        req,
        () => new Response("ok", { status: 200 }),
      );

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    } finally {
      if (previous === undefined) {
        delete process.env.MAINTENANCE_MODE;
      } else {
        process.env.MAINTENANCE_MODE = previous;
      }
    }
  });
});

describe("secureRoutes", () => {
  test("decorates every handler's response with security headers", async () => {
    const routes = secureRoutes({
      "/thing": (_req) => new Response("thing"),
    });

    const req = createBunRequest("http://localhost:3000/thing");
    const res = await routes["/thing"](req);

    expect(await res.text()).toBe("thing");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  test("awaits async handlers before decorating", async () => {
    const routes = secureRoutes({
      "/async": async (_req) => new Response("async"),
    });

    const req = createBunRequest("http://localhost:3000/async");
    const res = await routes["/async"](req);

    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
