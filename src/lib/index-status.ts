/**
 * A document whose indexing job is queued or running, and so will change.
 *
 * Its own module rather than a helper in `agents-store`, because the explorer
 * and the store both poll on it and tests replace the store wholesale.
 */
export function indexingNow(doc: { indexStatus?: string | null }): boolean {
  return doc.indexStatus === "queued" || doc.indexStatus === "indexing";
}
