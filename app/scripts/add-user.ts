#!/usr/bin/env bun

/* biome-ignore-all lint/suspicious/noConsole: this is an operator CLI script */

// Operator-only: provision a CMS user.
//
// CMS sign-in is invite-only. Magic-link sign-in only looks up an existing
// `cms_users` row, so there is no self-serve sign-up: an operator adds accounts
// here. Idempotent — an email that already has an account is left untouched.
//
// Run from the repository root:
//
//   bun run cms:add-user someone@example.com

import { findOrCreateUser, findUserByEmail } from "../src/server/services/auth";
import { closeDatabase } from "../src/server/services/database";

const email = (process.argv[2] ?? "").trim().toLowerCase();

if (!email) {
  console.error("Usage: bun run cms:add-user <email>");
  process.exit(1);
}

if (!email.includes("@")) {
  console.error(`Not an email address: ${email}`);
  process.exit(1);
}

try {
  const existing = await findUserByEmail(email);

  if (existing) {
    console.log(`${existing.email} already has a CMS account; nothing to do.`);
  } else {
    const user = await findOrCreateUser(email);
    console.log(`Added a CMS account for ${user.email}.`);
  }
} finally {
  await closeDatabase();
}
