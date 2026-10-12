/**
 * A stand-in for a mis-wired site config: it exports nothing the publish step
 * reads, so `cms:publish` must stop with a clear error rather than publish an
 * empty set by accident.
 */
export const note = "no definitions here";
