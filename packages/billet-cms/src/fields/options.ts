/**
 * Option checks shared by the field vocabulary and a page type's block limits.
 *
 * A site's declarations are plain data by the time the publish step sees them,
 * but the constructors are where a developer gets the feedback: a negative
 * `max` or a `min` above a `max` is a typo that would otherwise surface as an
 * editor unable to fill a form, so it throws at declaration instead.
 */

/** Throw unless `value` is an integer of at least zero. */
export const assertNonNegativeInteger = (
  value: number,
  label: string,
): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer, got ${value}`);
  }
};

/** Throw when both bounds are present and `min` exceeds `max`. */
export const assertMinMax = (
  min: number | undefined,
  max: number | undefined,
  label: string,
): void => {
  if (min === undefined || max === undefined) return;
  if (min > max) {
    throw new Error(
      `${label} min (${min}) must not be greater than max (${max})`,
    );
  }
};
