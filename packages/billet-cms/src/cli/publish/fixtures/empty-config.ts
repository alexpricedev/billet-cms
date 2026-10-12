/**
 * A site that declares nothing, the supported way: every collection is exported
 * as an explicit empty array, so `cms:publish` publishes an empty set rather
 * than treating the absent keys as a mis-wired config.
 */
export const blocks = [];
export const pageTypes = [];
export const slots = [];
