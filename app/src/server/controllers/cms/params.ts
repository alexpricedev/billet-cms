/**
 * The slot id comes straight from the URL. Postgres answers a non-UUID with
 * `invalid input syntax for type uuid`, which would surface as a 500 for what
 * is really a missing page, so every slot route checks it first.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
