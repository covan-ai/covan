import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * How many passages one workspace may hold, when the operator has said.
 *
 * WHY PASSAGES. What a document costs the database is not its file — that is
 * in the document store — but its passages: one per ~850 characters of text,
 * each carrying a 1536-wide vector, about 7 KB in Postgres all told. Measured
 * in covan-cloud#314, that is roughly 8.5 times the text it came from, so a
 * hosted database of 500 MB was full after about 59 MB of documents across
 * every workspace, and one workspace could fill it alone. Bytes uploaded would
 * be the wrong thing to count: a 40 MB scan with no text costs nothing here,
 * and a 2 MB CSV costs a great deal.
 *
 * Unset is no ceiling, which is every self-hosted install unless its operator
 * asks for one — a database somebody runs for themselves is theirs to fill.
 */
export type CeilingEnv = { WORKSPACE_MAX_PASSAGES?: string };

export function passageCeiling(env: CeilingEnv): number | null {
  const raw = (env.WORKSPACE_MAX_PASSAGES ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `WORKSPACE_MAX_PASSAGES must be a positive whole number, or unset for no ceiling ` +
        `(got ${JSON.stringify(raw)}).`,
    );
  }
  return n;
}

/**
 * Passages the workspace holds outside one document.
 *
 * That document's own are left out because reindexing replaces them: counted,
 * a workspace at its ceiling could never reindex anything, only delete. Called
 * by the indexing job, which already holds the service-role client — every
 * passage counts against the workspace, including a colleague's private ones
 * the caller of an upload could never see.
 */
export async function passagesOutside(
  db: SupabaseClient,
  workspaceId: string,
  documentId: string,
): Promise<number> {
  const { count, error } = await db
    .from("document_chunks")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .neq("document_id", documentId);
  if (error) throw new Error(`could not count the workspace's passages: ${error.message}`);
  return count ?? 0;
}

/** What a document that does not fit says, on its row and in the knowledge view. */
export function ceilingReason(held: number, needed: number, ceiling: number): string {
  return (
    `this workspace's knowledge is full: it holds ${held.toLocaleString("en-US")} passages, ` +
    `this document needs ${needed.toLocaleString("en-US")}, and the limit is ` +
    `${ceiling.toLocaleString("en-US")}. Remove documents nobody needs, then reindex this one.`
  );
}
