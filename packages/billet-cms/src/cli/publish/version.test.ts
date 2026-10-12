import { describe, expect, test } from "bun:test";
import { CONTRACT_VERSION } from "../../contract";
import {
  assertContractVersion,
  CmsNotSetUpError,
  ContractVersionMismatchError,
} from "./version";

describe("assertContractVersion", () => {
  test("accepts the version this build speaks", () => {
    expect(() => assertContractVersion(CONTRACT_VERSION)).not.toThrow();
  });

  test("stops with both versions named when they differ", () => {
    try {
      assertContractVersion("0.0.1");
      throw new Error("expected assertContractVersion to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractVersionMismatchError);
      const mismatch = error as ContractVersionMismatchError;
      expect(mismatch.cmsVersion).toBe("0.0.1");
      expect(mismatch.siteVersion).toBe(CONTRACT_VERSION);
      expect(mismatch.message).toContain("0.0.1");
      expect(mismatch.message).toContain(CONTRACT_VERSION);
      expect(mismatch.message).toMatch(/contract version mismatch/i);
    }
  });

  test("treats a missing or empty version as not set up, not a mismatch", () => {
    for (const value of [undefined, null, ""]) {
      expect(() => assertContractVersion(value)).toThrow(CmsNotSetUpError);
    }
  });

  test("says how to fix an unset CMS", () => {
    try {
      assertContractVersion(undefined);
      throw new Error("expected assertContractVersion to throw");
    } catch (error) {
      expect((error as Error).message).toMatch(/isn't set up/);
    }
  });
});
