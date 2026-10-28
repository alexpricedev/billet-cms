/**
 * Copy both sides render about an image's width.
 *
 * A `minWidth` shortfall is a warning rather than a refusal (see
 * `server/services/media/guidance.ts`): the save goes ahead, and the editor is
 * told. `cms-form.ts` writes `narrowImageWarning` beside the field when the
 * picker changes, from the width the server already rendered onto the option,
 * and the controllers put `narrowImagesSentence` in the banner that the save's
 * redirect lands on — so the two must agree, and the sentences live here rather
 * than in both places.
 *
 * No DOM and no `node:` imports: this is `src/shared/` (see `boundaries.test`).
 */
export const narrowImageWarning = (width: number, minWidth: number): string =>
  `This image is ${width}px wide. It is under the ${minWidth}px this field wants. You can save it, but it may look soft.`;

/**
 * The banner sentence after a save or publish that carried narrow-image
 * warnings, appended to the action's own notice.
 *
 * The field itself says the detail (see the `data-image-warning` slot the form
 * renders); this is the line that makes a redirect, which shows no form state
 * of its own, still say the save was not quite clean.
 */
export const narrowImagesSentence = (count: number): string =>
  count === 1
    ? "One image is narrower than its field wants, so it may look soft."
    : `${count} images are narrower than their fields want, so they may look soft.`;
