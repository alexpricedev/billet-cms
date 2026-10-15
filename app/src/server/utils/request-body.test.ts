import { afterEach, describe, expect, test } from "bun:test";
import { MAX_UPLOAD_BYTES } from "@alexpricedev/billet-cms/contract";
import { MAX_REQUEST_BODY_BYTES } from "./request-body";

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("MAX_REQUEST_BODY_BYTES", () => {
  test("sits above the upload cap so multipart framing fits", () => {
    expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(MAX_UPLOAD_BYTES);
  });

  // `main.ts` hands this to `Bun.serve` as `maxRequestBodySize`. The unit
  // suite never boots the server, so the behaviour is reproduced here against a
  // server configured the same way: a body at the ceiling is read, and one
  // past it is refused with a 413 before the handler ever runs.
  test("a server using it refuses an oversized request", async () => {
    const server = Bun.serve({
      port: 0,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      async fetch(req) {
        await req.arrayBuffer();
        return new Response("ok");
      },
    });
    servers.push(server);
    const url = `http://localhost:${server.port}/`;

    const atLimit = await Bun.fetch(url, {
      method: "POST",
      body: new Uint8Array(MAX_REQUEST_BODY_BYTES),
    });
    expect(atLimit.status).toBe(200);

    const overLimit = await Bun.fetch(url, {
      method: "POST",
      body: new Uint8Array(MAX_REQUEST_BODY_BYTES + 1),
    });
    expect(overLimit.status).toBe(413);
  });
});
