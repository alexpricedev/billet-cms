/**
 * @alexpricedev/billet-cms
 *
 * The CMS app lives in `app/`; this package is the block plugin a site installs
 * and the contract both sides share. The entry point re-exports the contract
 * and the field vocabulary; `./contract`, `./fields` and `./cli/publish` are
 * also importable directly.
 */
export * from "./contract";
export * from "./fields";
