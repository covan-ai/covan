// worker/src/lib/routines/connection-source.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FeedItem } from "./feed";

/**
 * What a routine watching a connection reads.
 *
 * Deliberately not a provider client. 0043 built connections as a reconciler —
 * it lists what Notion or Drive holds now, compares versions, imports what
 * moved and removes what vanished — and the whole argument for that shape was
 * one substrate: everything downstream of "here is the text" treats a synced
 * document exactly like an uploaded one. Giving the routine engine its own
 * Notion client would undo that, and would mean a second place where "has this
 * changed?" is decided, with its own version comparison to get subtly
 * differently wrong.
 *
 * So this reads `documents`. The reconciler has already done the fetching, the
 * versioning and the removals; what is left is to say which of those rows the
 * routine has not reported yet, and that is `diffItems`' job, unchanged. The
 * items below go through the same diff, the same seen-key window, the same
 * per-run cap and the same silent first run as an RSS feed's.
 *
 * The cost is latency, and it belongs in the create dialog rather than hidden
 * here: a connection syncs every `sync_interval_minutes` (six hours by
 * default), so a routine pointed at one cannot see a change sooner than the
 * sync does, whatever its own cron says.
 */

/**
 * How many of a connection's documents one run reads.
 *
 * Ordered by `synced_at` descending, which is a real "recently changed"
 * ordering rather than a proxy: `importOne` writes that column only when a
 * document is actually added or updated, so a sync that finds nothing new
 * leaves every row's value alone.
 *
 * The bound matters for a large bundle. Everything returned here is marked seen
 * by `diffItems`, so the window has to be wide enough that a document cannot
 * fall out of the recent set and then reappear as new — 200 against a per-run
 * delivery cap of 10 leaves a wide margin. A connection whose sync changes more
 * than 200 documents between two routine runs would lose the oldest of them,
 * which is the same trade the feed cap makes and is reported the same way.
 */
export const MAX_CONNECTION_DOCUMENTS = 200;

export type ConnectionSourceInput = {
  /** The routine's own workspace. Never a caller's. */
  workspaceId: string;
  /** From `source_config.connectionId`. Absent means a malformed routine row. */
  connectionId: string | undefined;
};

export async function fetchConnectionItems(
  db: SupabaseClient,
  input: ConnectionSourceInput,
  limit: number = MAX_CONNECTION_DOCUMENTS,
): Promise<FeedItem[]> {
  const { workspaceId, connectionId } = input;

  if (!connectionId) {
    throw new Error("source_config.connectionId is required for a connection routine");
  }

  // SCOPING: `db` is the service-role client and row level security is not
  // filtering this. 0047's policy stops a routine being *written* against
  // another workspace's connection, and this stops one being *read* — which is
  // the half that still matters for rows written before 0047, and for anything
  // else that holds the service role. Matching on id alone would make a
  // tampered `source_config` a cross-tenant read whose result is then mailed
  // out of the product.
  const { data: connection, error: connectionError } = await db
    .from("connections")
    .select("id")
    .eq("id", connectionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (connectionError) {
    throw new Error(`connection lookup failed: ${connectionError.message}`);
  }
  if (!connection) {
    throw new Error("the connection this routine watches is not available in this workspace");
  }

  // Soft-deleted rows are excluded, unlike in the sync itself. A document the
  // reconciler withdrew has stopped grounding answers everywhere else in the
  // product, and reporting it here as something new would contradict that.
  //
  // The consequence is that a routine reports additions and edits but not
  // removals. Saying "the pricing sheet was taken down" would be worth having;
  // it needs the cursor to remember what it saw rather than only what was new,
  // and that is a wider change than this.
  const { data, error } = await db
    .from("documents")
    .select("id, name, content, external_url, external_version, synced_at")
    .eq("connection_id", connectionId)
    .is("deleted_at", null)
    .order("synced_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`could not read this connection's documents: ${error.message}`);
  }

  return (data ?? []).map(toItem);
}

type DocumentRow = {
  id: string;
  name: string | null;
  content: string | null;
  external_url: string | null;
  external_version: string | null;
  synced_at: string | null;
};

function toItem(row: DocumentRow): FeedItem {
  // Identity is the document *and its version*, so an edit arrives under a key
  // the cursor has not seen and is reported again. Keying on the id alone would
  // mean a document is announced when it first syncs and never again, however
  // many times somebody rewrites it — which for a watched handbook is the one
  // event worth watching for.
  //
  // `synced_at` stands in when a provider gives no version. It moves on every
  // real import for the same reason, so the property still holds.
  const version = row.external_version ?? row.synced_at ?? "";

  return {
    key: `${row.id}:${version}`,
    // A Notion page can genuinely have no title. The model is given the title,
    // the link and the excerpt and nothing else, so an empty string here is an
    // empty bullet in somebody's Slack.
    title: row.name?.trim() || "Untitled document",
    link: row.external_url ?? "",
    publishedAt: row.synced_at,
    summary: row.content ?? "",
  };
}
