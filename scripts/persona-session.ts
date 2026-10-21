#!/usr/bin/env bun

/* biome-ignore-all lint/suspicious/noConsole: CLI script */

/**
 * `bun run scripts/persona-session.ts <persona> --side site|cms`
 *
 * Prints the cookie that signs a fixture persona in, as `name=value` on stdout
 * (anything else goes to stderr, so `$(...)` captures just the cookie):
 *
 * - `--side site` is the fixture site's own session (story 01 starts here).
 * - `--side cms` is a CMS session, skipping the handoff. Tom is not an editor,
 *   so he has none.
 *
 * Run the fixtures first. The CMS's cookie only works while the CMS is started
 * with the sandbox pepper, which `bun run sandbox` does.
 */
import { createHmac } from "node:crypto";
import { SANDBOX_PEPPER } from "../fixtures/constants.ts";
import { findPersona, PERSONAS } from "../fixtures/personas.ts";
import { sandboxConfig } from "./sandbox-config.ts";
import { guardOrExit } from "./sandbox-guard.ts";

const usage = (): never => {
  console.error(
    `Usage: bun run scripts/persona-session.ts <${PERSONAS.map((p) => p.key).join("|")}> --side site|cms`,
  );
  process.exit(2);
};

const args = process.argv.slice(2);
const sideIndex = args.indexOf("--side");
const side = sideIndex === -1 ? undefined : args[sideIndex + 1];
const positional = args.filter(
  (_, index) => index !== sideIndex && index !== sideIndex + 1,
);
const person = positional[0] ? findPersona(positional[0]) : undefined;
if (!person || (side !== "site" && side !== "cms")) usage();

guardOrExit();

const { SQL } = await import("bun");
const { SITE_SESSION_COOKIE } = await import("../e2e/site.ts");
const config = sandboxConfig(process.env);
const sql = new SQL(process.env.DATABASE_URL as string, { max: 1 });

const fail = async (message: string): Promise<never> => {
  console.error(message);
  await sql.close();
  process.exit(1);
};

try {
  const users = (await sql`
    SELECT id FROM users WHERE email = ${person?.email}
  `) as { id: string }[];
  if (!users[0]) {
    await fail(
      `${person?.email} is not in users. Run \`bun run fixtures\` first.`,
    );
  }
  const userId = users[0].id;

  if (side === "site") {
    console.log(`${SITE_SESSION_COOKIE}=${userId}`);
    console.error(`Site origin ${config.siteUrl}; cookie is HttpOnly, path /.`);
  } else {
    const identity = (await sql`
      SELECT id FROM cms_identities WHERE id = ${userId}
    `) as { id: string }[];
    if (!identity[0]) {
      await fail(
        `${person?.email} is not in cms_identities, so the CMS has no session for them (they are refused at sign-in).`,
      );
    }
    const raw = person?.cmsSession as string;
    const hash = createHmac("sha256", SANDBOX_PEPPER).update(raw).digest("hex");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await sql`
      INSERT INTO cms_sessions (id_hash, user_id, session_type, expires_at)
      VALUES (${hash}, ${userId}, 'authenticated', ${expiresAt.toISOString()})
      ON CONFLICT (id_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at
    `;
    console.log(`${config.cmsCookieName}=${raw}`);
    console.error(`CMS origin ${config.cmsUrl}; cookie is HttpOnly, path /.`);
  }
} finally {
  await sql.close();
}
process.exit(0);
