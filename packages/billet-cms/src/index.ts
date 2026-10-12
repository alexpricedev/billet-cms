/**
 * @alexpricedev/billet-cms
 *
 * The CMS app lives in `app/`; this package is the block plugin a site installs
 * and the contract both sides share. Phase 1 ships the contract skeleton only,
 * so the entry point re-exports it. Later phases add the field vocabulary,
 * `block()` / `slot()` / page types, the publish step and the read helpers.
 */
export * from "./contract";
