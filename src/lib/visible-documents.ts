import type { Bundle } from "./api-client";

type Placed = { bundleId?: string };
type Folder = Pick<Bundle, "id" | "shared">;

/**
 * The documents a conversation can be grounded in.
 *
 * A shared conversation is answered from shared folders only — the server's
 * `sharedOnly` scope (`worker/src/lib/retrieval.ts`) leaves everybody's
 * private folders out, the asker's included, so that one person's private
 * file never grounds a reply the whole workspace reads. The screen used to
 * count every document the agent had anyway: a tester asked the same question
 * in a shared thread, was told nothing was found, and read "grounded in 1
 * document" under the answer. Both were true and together they read as broken.
 *
 * `shared` undefined is shared — a fixture or an older response. A document
 * with no `bundleId`, or in a folder this list does not know, is kept: the
 * server decides, and the honest reading of "not told" is "not excluded".
 */
export function visibleDocuments<D extends Placed>(
  documents: readonly D[],
  bundles: readonly Folder[],
  shared: boolean,
): D[] {
  if (!shared) return [...documents];
  const isPrivate = new Set(bundles.filter((b) => b.shared === false).map((b) => b.id));
  return documents.filter((d) => !d.bundleId || !isPrivate.has(d.bundleId));
}

/** How many of the agent's documents a shared conversation cannot read. */
export function hiddenByPrivacy(
  documents: readonly Placed[],
  bundles: readonly Folder[],
  shared: boolean,
): number {
  return documents.length - visibleDocuments(documents, bundles, shared).length;
}
