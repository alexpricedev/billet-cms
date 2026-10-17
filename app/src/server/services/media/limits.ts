/**
 * The media picker's cap, in a module with no imports.
 *
 * A server component, its tests and the page and slot controllers all read
 * `MEDIA_PICKER_LIMIT`. Keeping it here rather than in `./media` means those
 * imports don't load the media barrel — and with it the database module (which
 * throws at import without `DATABASE_URL`), Sharp and the S3 storage — just to
 * read a constant. `media.ts` re-exports it, so the service's own surface is
 * unchanged.
 */
export const MEDIA_PICKER_LIMIT = 50;
