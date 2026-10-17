/**
 * The shape of a Postgres `uuid`.
 *
 * An id comes from a URL or a posted document. Postgres answers a non-UUID with
 * `invalid input syntax for type uuid`, which surfaces as a 500 for what is
 * really a missing row or a typo, so anything that hands an id to a `uuid`
 * column checks it first. The pattern lives in `utils/` rather than a
 * controller module so the media service — which reads the ids a draft
 * references before it queries `cms_media` — can filter without importing a
 * controller.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The UUIDs in `ids`, in order. */
export const filterUuids = (ids: readonly string[]): string[] =>
  ids.filter((id) => UUID_PATTERN.test(id));
