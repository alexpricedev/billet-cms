import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { urlProblem, validateEnv } from "./env";

const NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = NODE_ENV;
});

describe("urlProblem", () => {
  test("accepts an absolute https URL", () => {
    expect(urlProblem("APP_URL", "https://example.com")).toBeNull();
  });

  test("accepts http outside production, where localhost has no TLS", () => {
    expect(urlProblem("APP_URL", "http://localhost:3000")).toBeNull();
  });

  test("rejects a value with no scheme", () => {
    expect(urlProblem("APP_URL", "example.com")).toBe(
      'APP_URL must be an absolute URL including the scheme (got "example.com")',
    );
  });

  // new URL() parses this happily and reports an origin of the literal string
  // "null", which would ship canonicals reading "null/cms".
  test("rejects a URL that parses but isn't http(s)", () => {
    expect(urlProblem("SITE_URL", "mailto:hi@example.com")).toBe(
      'SITE_URL must use http:// or https:// (got "mailto:hi@example.com")',
    );
  });

  test("rejects http in production", () => {
    process.env.NODE_ENV = "production";

    expect(urlProblem("APP_URL", "http://example.com")).toBe(
      'APP_URL must use https:// in production (got "http://example.com")',
    );
  });

  test("names the key it was given, so the message points at the fix", () => {
    expect(urlProblem("SITE_URL", "nope")).toContain("SITE_URL");
  });
});

// validateEnv() reads process.env and answers a bad value with exit(1). The
// preload pins a valid environment, so each case mutates one variable and the
// afterEach restores it. A recorded `exit` stands in for process.exit.
const ENV_KEYS = [
  "DATABASE_URL",
  "CRYPTO_PEPPER",
  "PORT",
  "APP_NAME",
  "APP_URL",
  "SITE_APP_URL",
  "SITE_URL",
  "TRUST_PROXY",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

/** Run validateEnv with a recorded exit, capturing the error log lines. */
const runValidateEnv = (): { code: number | null; errors: string[] } => {
  let code: number | null = null;
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    validateEnv((exitCode) => {
      code = exitCode;
    });
  } finally {
    console.error = original;
  }
  return { code, errors };
};

describe("validateEnv", () => {
  test("boots when the environment is complete", () => {
    const { code } = runValidateEnv();

    expect(code).toBeNull();
  });

  // The CMS has no sign-in of its own, so without the site's URL it can sign
  // nobody in. Null, empty and whitespace-only all count as missing.
  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])("refuses to boot when SITE_APP_URL is %s", (_label, value) => {
    if (value === undefined) {
      delete process.env.SITE_APP_URL;
    } else {
      process.env.SITE_APP_URL = value;
    }

    const { code, errors } = runValidateEnv();

    expect(code).toBe(1);
    expect(errors.some((line) => line.includes("SITE_APP_URL"))).toBe(true);
  });

  test("refuses to boot when SITE_APP_URL is not a valid URL", () => {
    process.env.SITE_APP_URL = "example.com";

    const { code, errors } = runValidateEnv();

    expect(code).toBe(1);
    expect(
      errors.some(
        (line) =>
          line.includes("SITE_APP_URL") &&
          line.includes("absolute URL including the scheme"),
      ),
    ).toBe(true);
  });
});
