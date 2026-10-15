// worker/src/lib/routines/filing.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocumentEnv } from "../../types";
import { hasIndexableText } from "../extract";
import { fileGeneratedDocument } from "../docs/file";

/**
 * Filing a routine's result into a knowledge bundle.
 *
 * What this is for: a routine that only delivers is a thing that mails you; a
 * routine that also files is a thing that accumulates. Fifty-two weekly
 * competitor digests in a bundle are a year of history an agent can be asked a
 * question of — "what did they ship in Q2?" — which is a question no Slack
 * channel answers.
 *
 * ONE DOCUMENT PER RUN, and the two alternatives were both considered and
 * dropped:
 *
 *   - Appending to a single growing document. `chunkText` re-cuts boundaries
 *     over the whole text, so every append re-embeds the entire history. The
 *     cost grows with the square of the number of runs, and the fiftieth
 *     weekly digest would pay to re-embed the previous forty-nine.
 *   - Replacing the document each run, the way a connection sync does. A
 *     connection *reconciles* — it answers "what is there now" — and a routine
 *     has a cursor, which answers "what changed since". Week 12's summary is
 *     not made wrong by week 13; it is history, and history is the feature.
 *
 * THE LOOP, which this does not fully close and must be read as a known gap.
 * A routine whose agent has the output bundle attached will retrieve its own
 * previous summaries on later runs. That is self-reference rather than a
 * runaway loop — each run still summarises fresh material, and nothing
 * compounds — but it is real, and the interface says so where the bundle is
 * chosen. Closing it properly means telling `match_chunks` to exclude one
 * routine's own output while leaving chat and other routines able to read it,
 * which is a sixth parameter and therefore an overload with a `PGRST203` risk.
 * That is deferred rather than forgotten.
 *
 * The other loop — a routine watching a connection reporting documents another
 * routine filed into it — IS closed, structurally, in `connection-source.ts`:
 * it filters `routine_id is null`. Before `documents.routine_id` existed, that
 * loop was held shut by nothing more than a `where connection_id = ?` and the
 * fact that a filed document had no connection.
 */

/**
 * Chunk geometry for a filed summary, matching `POST /sessions/:id/report`.
 *
 * Wider than the 1,000-character default used for uploads, for the same reason
 * reports are: this text was written to be read top to bottom, and cutting it
 * at a thousand characters separates a heading from the paragraph that
 * explains it. A digest is the same shape of document.
 */
export const FILING_CHUNK_SIZE = 2400;
export const FILING_CHUNK_OVERLAP = 200;

/**
 * How many documents one prune may hide.
 *
 * A bound rather than a guess: retention only ever goes over by one per run, so
 * this is only ever reached the first time somebody lowers the number — and a
 * prune that has to hide four hundred rows should do it over four runs rather
 * than in one statement that may not finish inside a Worker's budget.
 */
export const MAX_PRUNE_PER_RUN = 100;

/**
 * Why a run that was supposed to file did not.
 *
 * Constants rather than inline strings because they are written to
 * `routine_runs.filing_note` and read by a person looking at a run that says
 * "Sent" and nothing about a document. Two of them are raised by the executor
 * rather than here, which is why they are exported.
 */
export const NOTE_NO_DOCUMENT_STORE =
  "not filed: this deployment's scheduled worker has no document storage bound";
export const NOTE_VIEWER =
  "not filed: the routine's owner is a viewer in this workspace and cannot write documents";
export const NOTE_BUNDLE_GONE =
  "not filed: the bundle this routine files to is no longer available in this workspace";
export const NOTE_EMPTY = "not filed: the delivered text had nothing to index";

export type FilingInput = {
  routineId: string;
  routineName: string;
  /** The routine's own workspace, read off its row. Never a caller's. */
  workspaceId: string;
  /** `routines.output_bundle_id`. Verified against the workspace below. */
  bundleId: string;
  /** `routines.output_retention`. */
  retention: number;
  /** The text that was delivered, exactly as it was sent. */
  summary: string;
  /** When the run started. The document is named after the run, not the clock. */
  at: Date;
};

export type FilingResult =
  { filed: true; documentId: string; indexTokens: number } | { filed: false; note: string };

/**
 * What the document is called in the Knowledge tab.
 *
 * Not sanitised — `documents.name` is what a person reads, and `safeName` is
 * for the object key only. That split is the upload route's and the report
 * route's; running a Turkish routine name through it here would show
 * "Ayl_k_Rapor" on screen for the sake of a key nobody sees.
 *
 * Two runs on the same day produce two documents with the same name. That is
 * left alone deliberately: it is what happened, the rows are distinguished by
 * their timestamps, and a disambiguating suffix would put a clock on fifty-one
 * weekly digests that do not need one to spare the fifty-second.
 */
export function filedDocumentName(routineName: string, at: Date): string {
  return `${routineName} — ${at.toISOString().slice(0, 10)}.md`;
}

/**
 * The text that is stored and embedded.
 *
 * Headed, because a retrieved passage arrives in a chat turn with nothing
 * around it: a chunk that opens "they also announced a price change" is a
 * sentence about nobody, and one that opens under "# Competitor digest —
 * 2026-09-20" is dated evidence. The heading is also what `reportTitle` would
 * read back, which keeps a filed summary and a generated report the same kind
 * of file.
 */
export function filedDocumentText(routineName: string, at: Date, summary: string): string {
  return `# ${routineName} — ${at.toISOString().slice(0, 10)}\n\n${summary.trim()}\n`;
}

/**
 * Files one delivered summary, prunes what has aged out, and says what happened.
 *
 * NEVER THROWS. Every failure comes back as `{ filed: false, note }`. This is
 * not defensive style, it is the contract: the caller has already delivered the
 * message, and an exception here would be caught by `runRoutine`, recorded as a
 * failure, backed off geometrically and — at `MAX_FAILURES` — would pause a
 * routine that is working. Filing is the optional half of a run and is not
 * allowed to be the half that breaks it.
 *
 * SCOPING: `db` is the service-role client and RLS is not filtering any of
 * this. The bundle is therefore matched against the routine's own
 * `workspace_id` below, not by id alone. 0056's policies already stop a
 * caller writing a foreign bundle id onto the row; this is the second half of
 * the same guard, for rows written before it and for anything else that holds
 * the service role.
 */
export async function fileRoutineOutput(
  db: SupabaseClient,
  env: DocumentEnv,
  input: FilingInput,
): Promise<FilingResult> {
  try {
    // The same gate the upload form and the sync apply, asked of the SUMMARY
    // rather than of the composed text. The heading below would make anything
    // indexable, so asking after composing would file a document whose entire
    // content is its own title — which is the exact shape of a document that is
    // listed, named to the model on every turn, and answers nothing.
    if (!hasIndexableText(input.summary)) return { filed: false, note: NOTE_EMPTY };

    const filed = await fileGeneratedDocument(db, env, {
      workspaceId: input.workspaceId,
      bundleId: input.bundleId,
      name: filedDocumentName(input.routineName, input.at),
      text: filedDocumentText(input.routineName, input.at, input.summary),
      routineId: input.routineId,
      chunkSize: FILING_CHUNK_SIZE,
      chunkOverlap: FILING_CHUNK_OVERLAP,
    });

    if (!filed.filed) {
      return {
        filed: false,
        note: filed.reason === "bundle_gone" ? NOTE_BUNDLE_GONE : `not filed: ${filed.note}`,
      };
    }

    // Past here the run has filed something. Pruning is best-effort on top of
    // that: a prune that fails leaves more documents than asked for.
    await pruneOldOutput(db, input.routineId, input.workspaceId, input.retention);

    return { filed: true, documentId: filed.documentId, indexTokens: filed.indexTokens };
  } catch (err) {
    return { filed: false, note: `not filed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Hides everything this routine filed beyond its retention.
 *
 * Soft-deleted, not removed, because that is what deletion means everywhere
 * else in this product since 0040 — and `lib/purge.ts` is what eventually
 * reclaims the bytes, on the same schedule as every other deleted document.
 *
 * `deleted_via` is set to the routine's own id, and that is the column's
 * documented meaning rather than a borrowed use of it: it names which ancestor
 * hid the row. The consequence is the one that is wanted — `workspace_trash`
 * lists only rows with `deleted_via is null`, so a routine's aged-out digests
 * do not arrive in Recently Deleted once a week for the rest of the year
 * pretending somebody deleted them. `deleted_by` stays null, because nobody
 * did.
 *
 * Best-effort: a prune that fails leaves more documents than asked for, which
 * is the harmless direction. The run has already filed.
 */
async function pruneOldOutput(
  db: SupabaseClient,
  routineId: string,
  workspaceId: string,
  retention: number,
): Promise<void> {
  try {
    // The routine's own workspace, for the reason `fileRoutineOutput` scopes
    // the bundle: a row elsewhere claiming this routine would otherwise count
    // towards its retention and push its real output out of view.
    const { data, error } = await db
      .from("documents")
      .select("id, knowledge_bundles!inner(workspace_id)")
      .eq("routine_id", routineId)
      .eq("knowledge_bundles.workspace_id", workspaceId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .range(retention, retention + MAX_PRUNE_PER_RUN - 1);

    if (error || !data || data.length === 0) return;

    const { error: hideError } = await db
      .from("documents")
      .update({ deleted_at: new Date().toISOString(), deleted_by: null, deleted_via: routineId })
      .in(
        "id",
        data.map((d) => d.id),
      );
    if (hideError) console.error("routine filing: retention prune failed", hideError);
  } catch (err) {
    console.error("routine filing: retention prune failed", err);
  }
}
