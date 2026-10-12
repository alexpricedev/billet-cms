/**
 * The publish-time contract check.
 *
 * Setup order is CMS first, then the site (spec: "The plugin's publish step
 * checks it and stops with a clear message if the CMS isn't set up or the
 * versions don't match"). Both failures are their own error type so a caller —
 * or a test — can tell them apart from a genuine fault.
 */
import { CONTRACT_VERSION } from "../../contract";

/** The CMS has never been set up in this database. */
export class CmsNotSetUpError extends Error {
  constructor() {
    super(
      "Billet CMS isn't set up in this database: the cms_meta table that records " +
        "the contract version is missing or empty. Set up the CMS first — deploy " +
        "it, or run its migrations (`bun run migrate:up` in app/) — then publish.",
    );
    this.name = "CmsNotSetUpError";
  }
}

/** The CMS and the site's plugin disagree about the contract version. */
export class ContractVersionMismatchError extends Error {
  readonly cmsVersion: string;
  readonly siteVersion: string;

  constructor(cmsVersion: string, siteVersion: string = CONTRACT_VERSION) {
    super(
      "Billet CMS contract version mismatch: the CMS in this database speaks " +
        `${cmsVersion}, but this site's plugin speaks ${siteVersion}. Deploy ` +
        `matching versions — upgrade the CMS to ${siteVersion}, or pin the site's ` +
        "@alexpricedev/billet-cms to the version the CMS speaks — then publish again.",
    );
    this.name = "ContractVersionMismatchError";
    this.cmsVersion = cmsVersion;
    this.siteVersion = siteVersion;
  }
}

/**
 * Throw unless the CMS's stored contract version matches this build's.
 *
 * A missing version is `CmsNotSetUpError` rather than a mismatch: there is
 * nothing to compare against, and the fix is setup, not a version bump.
 */
export const assertContractVersion = (
  cmsVersion: string | null | undefined,
): void => {
  if (cmsVersion === null || cmsVersion === undefined || cmsVersion === "") {
    throw new CmsNotSetUpError();
  }
  if (cmsVersion !== CONTRACT_VERSION) {
    throw new ContractVersionMismatchError(cmsVersion, CONTRACT_VERSION);
  }
};
