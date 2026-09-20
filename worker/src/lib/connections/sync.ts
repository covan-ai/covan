import type { SupabaseClient } from "@supabase/supabase-js";
import type { SyncEnv } from "../../types";
import type { Entitlements } from "../entitlements";
import { embeddingCost } from "../entitlements";
import { chunkText, embedTexts } from "../embeddings";
import { insertChunkRows } from "../chunk-store";
import { getDocStore } from "../docstore";
import { EXCERPT_LIMIT, hasIndexableText, safeName } from "../extract";
import { decryptSecret, encryptSecret } from "../secret-box";
import { billsTheOperator, keysForUser, withProviderKeys } from "../keys/resolve";
import { providerFor } from "./registry";
import {
  ProviderError,
  type ConnectionProvider,
  type ProviderContext,
  type RemoteFile,
  type TokenEnvelope,
} from "./types";

/**
 * One sync: what the source holds now, made true here.
 *
 * The engine is a reconciler, not a feed reader. It lists everything the
 * connection can see, compares each file's version against the copy already in
 * the bundle, and then does the smallest set of writes that makes the two
 * agree — including deletions, which is the half that a "what changed since
 * last time" API cannot answer and the half that matters most: a policy
 * withdrawn at the source has to stop grounding answers here, and the failure
 * mode of getting that wrong is an agent confidently citing a document its own
 * company has retracted.
 *
 * Everything after "here is the text" is the upload path, unchanged —
 * `chunkText`, `embedTexts`, `insertChunkRows`, the same store, the same
 * `documents` row shape. A synced document is not a second kind of document.
 */

/**
 * How many documents one run may import.
 *
 * The binding constraint is Cloudflare's **Free** plan: 50 subrequests per
 * invocation, shared by everything the tick does. One document costs a read
 * from the provider (1, or 2 for a Drive export that falls back), an embedding
 * call (1), and three Supabase writes — the row, the chunk delete, the chunk
 * insert. Call it 6. With the claim, the membership check, the listing (up to
 * 6 for a Drive tree), the adoption pass, the removal delete and the two
 * bookkeeping writes, five documents lands around 45.
 *
 * A run that hits the cap is not finished, and says so by asking to be run
 * again in a minute rather than waiting out the whole interval — so a first
 * sync of two hundred pages drains over an hour of ticks instead of never
 * completing.
 */
export const MAX_DOCUMENTS_PER_RUN = 5;

/**
 * How many documents one run may remove.
 *
 * Deletions are cheaper than imports — one database call for all of them, plus
 * one store delete each — but not free, and a folder that somebody empties
 * should not blow the subrequest budget in a single tick.
 */
const MAX_REMOVALS_PER_RUN = 20;

/**
 * What counts as the source suddenly showing far less than it did.
 *
 * A sync reconciles: it lists what the source holds now and hides the
 * documents that are no longer in that listing. That is correct by its own
 * rules and catastrophic in one particular case — a connection reconnected
 * with a different person's grant. Alice could see 400 files, Bob can see 120,
 * and the next run is entirely right to conclude that 280 documents have gone.
 * The team loses most of a bundle to somebody being helpful.
 *
 * `MAX_REMOVALS_PER_RUN` is not a defence against that. It bounds the
 * subrequest cost of one run, so the 280 would go over fourteen runs instead of
 * one — slower, and the same outcome.
 *
 * So a run that would remove a large share of what it has stops and asks. Both
 * numbers matter: the fraction is what makes it proportionate to the bundle,
 * and the floor is what stops a five-document connection tripping on a folder
 * somebody tidied. Below the floor nothing can trip at all, which is the right
 * answer — "three of your three documents went" is not a mass deletion, it is a
 * small folder being emptied.
 *
 * This is not only about reconnects. A Drive folder someone stops sharing, a
 * Notion integration narrowed by an admin, a provider having a bad listing day:
 * all of them look like this from here, and the answer to all of them is to ask
 * rather than to act.
 */
const NARROWING_FRACTION = 0.2;
const MIN_NARROWING = 5;

/**
 * Whether hiding this many of that many is a narrowing rather than a tidy-up.
 *
 * Exported for the test, and because the interface says the same sentence.
 */
export function isNarrowing(removing: number, total: number): boolean {
  return removing >= Math.max(MIN_NARROWING, Math.ceil(total * NARROWING_FRACTION));
}

/**
 * Consecutive failures before the connection pauses itself.
 *
 * The same shape as `routines`, and the same reasoning: a connection that dies
 * quietly while the interface still says "active" is the failure that destroys
 * trust in the feature. The split between the two numbers is where the
 * reasoning differs — a `retryable` failure is the provider's weather, and
 * with backoff, twenty of them means Notion has been unreachable for days.
 */
export const MAX_FAILURES = 5;
export const MAX_TRANSIENT_FAILURES = 20;

/** Backoff never pushes a connection more than this far past its natural next sync. */
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** How soon a capped run comes back for the rest of its work. */
const CONTINUE_SOON_MS = 60 * 1000;

export type ConnectionRow = {
  id: string;
  workspace_id: string;
  bundle_id: string;
  /**
   * The grant holder, or null once they have closed their Covan account.
   *
   * Nullable since 0057, and the null is the whole of that migration: a
   * connection belongs to its workspace and has to survive the person whose
   * OAuth grant it carries. What it cannot survive is the grant itself, so a
   * null here means paused and waiting for somebody to reconnect it.
   */
  user_id: string | null;
  provider: string;
  account_label: string;
  secret_ciphertext: string;
  config: Record<string, unknown> | null;
  status: "active" | "paused";
  /**
   * Why the engine paused it, when it did. Read by the API rather than by the
   * engine — `PATCH /connections/:id` needs to know which pause a person is
   * resuming from, because resuming from `access_narrowed` means something
   * more than "start again".
   */
  paused_code?: PausedCode | null;
  sync_interval_minutes: number;
  consecutive_failures: number;
  /**
   * Set when a person resumed this after an `access_narrowed` pause, meaning
   * "yes, really remove those". Honoured once, by the next run.
   */
  removals_approved_at?: string | null;
};

/**
 * Why the engine paused a connection, as something a program can branch on.
 *
 * Mirrors 0057's CHECK exactly. The interface uses it to decide between
 * offering Resume and offering Reconnect, which it used to decide by matching
 * the prose in `paused_reason` — and those are different answers to a revoked
 * grant and to a folder that has gone quiet.
 */
export type PausedCode =
  | "needs_folder"
  | "owner_left"
  | "owner_gone"
  | "grant_revoked"
  | "repeated_failures"
  | "provider_unconfigured"
  | "unknown_provider"
  | "access_narrowed"
  | "restored";

export type SyncDeps = {
  /** Service-role client. See the scoping note in `runConnection`. */
  db: SupabaseClient;
  env: SyncEnv;
  entitlements: Entitlements;
  fetchImpl: typeof fetch;
  now: () => Date;
};

export type SyncOutcome = {
  status: "ok" | "skipped" | "failed";
  added: number;
  updated: number;
  removed: number;
  /** True when the run stopped at MAX_DOCUMENTS_PER_RUN with work left. */
  more: boolean;
};

type ExistingDocument = {
  id: string;
  external_id: string | null;
  external_version: string | null;
  r2_key: string | null;
  /**
   * Where the document actually is, which is not always where this connection
   * put it: a synced document can be moved to another bundle like any other
   * (`PATCH /documents/:id`). Read so that re-importing it writes its passages
   * into the bundle the document is in rather than the one the connection feeds
   * — see the note in `importOne`.
   */
  bundle_id: string | null;
  /** Set once 0040 has hidden it. Soft-deleted rows are still ours to reconcile. */
  deleted_at: string | null;
};

/**
 * Run one connection.
 *
 * The client is service-role and therefore bypasses RLS, exactly as the routine
 * executor's does and for the same reason: there is no request and no session
 * to carry. Every read and write below is scoped by hand to
 * `connection.workspace_id` and `connection.bundle_id` — the two values that
 * came out of `claim_due_connections`, not out of anything a caller sent — and
 * the first thing the function does is check that the owner is still a member
 * of that workspace. A connection whose owner has left stops rather than
 * carrying on with their access.
 */
export async function runConnection(
  connection: ConnectionRow,
  deps: SyncDeps,
): Promise<SyncOutcome> {
  const startedAt = deps.now();

  const provider = providerFor(connection.provider);
  if (!provider) {
    return finish(connection, deps, startedAt, {
      status: "failed",
      added: 0,
      updated: 0,
      removed: 0,
      more: false,
      error: `unknown provider: ${connection.provider}`,
      pause: `Covan no longer knows how to sync ${connection.provider}.`,
      pauseCode: "unknown_provider",
    });
  }

  if (!provider.isConfigured(deps.env)) {
    // Paused rather than failed, because nothing about this connection is
    // broken — the deployment stopped offering the provider. Retrying every six
    // hours would fill the log with a message about somebody else's
    // configuration.
    return finish(connection, deps, startedAt, {
      status: "failed",
      added: 0,
      updated: 0,
      removed: 0,
      more: false,
      error: `${provider.label} is not configured on this deployment`,
      pause: `${provider.label} is not configured on this Covan any more. An operator has to set its client credentials before this connection can resume.`,
      pauseCode: "provider_unconfigured",
    });
  }

  // Nobody holds the grant any more: they closed their Covan account, and
  // 0057's `on delete set null` is what let the connection outlive them. There
  // is no token that will work and no allowance to charge, so this stops before
  // the membership question, which has no subject.
  //
  // Paused rather than failed. Nothing is broken — the row is waiting for
  // somebody to reconnect it, which since 0057 is any member who can write.
  if (!connection.user_id) {
    const reason =
      "the person whose account this source was connected with has closed their Covan account. " +
      "Reconnect it to start syncing again; the documents it already imported are untouched.";
    return finish(connection, deps, startedAt, {
      status: "skipped",
      added: 0,
      updated: 0,
      removed: 0,
      more: false,
      error: reason,
      pause: reason,
      pauseCode: "owner_gone",
    });
  }

  const { data: membership, error: membershipError } = await deps.db
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", connection.workspace_id)
    .eq("user_id", connection.user_id)
    .maybeSingle();
  if (membershipError) {
    throw new Error(`workspace membership lookup failed: ${membershipError.message}`);
  }
  if (!membership) {
    const reason = "the person who connected this source is no longer a member of this workspace";
    return finish(connection, deps, startedAt, {
      status: "skipped",
      added: 0,
      updated: 0,
      removed: 0,
      more: false,
      error: reason,
      pause: reason,
      pauseCode: "owner_left",
    });
  }

  // Before anything is fetched or embedded. A sync spends the owner's
  // allowance, and the cursor-free design means a run skipped for quota costs
  // nothing to repeat: the next one lists the same files and finds the same
  // ones changed.
  const verdict = await deps.entitlements.check(connection.user_id);
  // The connection's owner may be past their allowance while their workspace
  // carries it. Resolved here rather than upstream because a sync has no
  // request to guard.
  const keys = await keysForUser(deps.env, deps.db, connection.user_id, verdict.allowed);
  const runEnv = withProviderKeys(deps.env, keys);
  if (!verdict.allowed && billsTheOperator(keys)) {
    return finish(connection, deps, startedAt, {
      status: "skipped",
      added: 0,
      updated: 0,
      removed: 0,
      more: false,
      error: QUOTA_SKIP_REASON,
    });
  }

  let tokens = 0;
  try {
    const stored = JSON.parse(
      await decryptSecret(connection.secret_ciphertext, deps.env.ROUTINE_SECRET_KEY),
    ) as TokenEnvelope;

    const token = await provider.refresh(deps.env, stored, deps.fetchImpl);
    if (token.accessToken !== stored.accessToken) {
      // Stored before it is used, not after: a run that refreshes, works for
      // twenty seconds and then dies would otherwise have thrown away a token
      // Google will not issue again.
      await deps.db
        .from("connections")
        .update({
          secret_ciphertext: await encryptSecret(
            JSON.stringify(token),
            deps.env.ROUTINE_SECRET_KEY,
          ),
          updated_at: deps.now().toISOString(),
        })
        .eq("id", connection.id);
    }

    const ctx: ProviderContext = {
      token,
      config: connection.config ?? {},
      fetchImpl: deps.fetchImpl,
    };

    const remote = await provider.listFiles(ctx);
    const byExternalId = new Map(remote.map((f) => [f.externalId, f]));

    await adoptOrphans(connection, deps, [...byExternalId.keys()]);

    // Soft-deleted rows are read too, and deliberately. 0040 hides them from
    // every client, but they are still the rows this connection owns: the
    // unique index on (connection_id, external_id) means importing "again"
    // would be a constraint violation rather than a fresh document, and a file
    // that comes back at the source has to come back here.
    const { data: existingRows, error: existingError } = await deps.db
      .from("documents")
      .select("id,external_id,external_version,r2_key,bundle_id,deleted_at")
      .eq("connection_id", connection.id);
    if (existingError) {
      throw new Error(`could not read this connection's documents: ${existingError.message}`);
    }
    const existing = (existingRows ?? []) as ExistingDocument[];
    const byId = new Map(existing.filter((d) => d.external_id).map((d) => [d.external_id!, d]));

    // What this run would hide, before it hides anything.
    //
    // The count is taken over everything, not over the capped slice: the
    // question is how much of the bundle has gone, and answering it from the
    // first twenty would say "20 of 400" every time.
    const vanished = existing
      .filter((doc) => !doc.deleted_at)
      .filter((doc) => !doc.external_id || !byExternalId.has(doc.external_id));
    const live = existing.filter((doc) => !doc.deleted_at).length;
    const approved = Boolean(connection.removals_approved_at);

    if (!approved && isNarrowing(vanished.length, live)) {
      // Nothing is removed and nothing is imported. Stopping before the import
      // half matters: a reconnect with a narrower grant would otherwise spend
      // the new holder's allowance re-embedding the files it can still see,
      // while the bundle waits to find out whether the rest are really gone.
      // Both numbers, because "some documents are missing" is not something
      // anybody can act on. The sentence deliberately names neither button:
      // the labels belong to the interface, and a message that quotes one is a
      // message that goes stale when somebody improves it.
      const reason =
        `${vanished.length} of ${live} documents are no longer visible at the source. ` +
        `That is usually an account that sees less than the last one did rather than files ` +
        `being deleted, so nothing has been removed. Either confirm that they really are ` +
        `gone, or reconnect with an account that can see them.`;
      return finish(connection, deps, startedAt, {
        status: "skipped",
        added: 0,
        updated: 0,
        removed: 0,
        more: false,
        error: reason,
        pause: reason,
        pauseCode: "access_narrowed",
      });
    }

    const removed = await removeVanished(deps, vanished);

    const changed = remote.filter((file) => {
      const current = byId.get(file.externalId);
      if (!current) return true;
      // A row this sync hid because the file had gone, and the file is back.
      // Re-importing is what brings it back, and it has to happen whether or not
      // the version moved while it was away.
      if (current.deleted_at) return true;
      return current.external_version !== file.version;
    });

    let added = 0;
    let updated = 0;
    for (const file of changed.slice(0, MAX_DOCUMENTS_PER_RUN)) {
      const result = await importOne(
        connection,
        deps,
        runEnv,
        provider,
        ctx,
        file,
        byId.get(file.externalId),
      );
      tokens += result.tokens;
      if (result.imported === "added") added++;
      if (result.imported === "updated") updated++;
    }

    // Removals are capped too, and a capped removal is work left over in
    // exactly the sense `more` already means. Without this a person who
    // approved a 280-document removal would watch it drain twenty per sync
    // interval — three and a half days on the default cadence — having
    // already said yes.
    const more = changed.length > MAX_DOCUMENTS_PER_RUN || vanished.length > MAX_REMOVALS_PER_RUN;
    // Only what the operator is billed for reaches the counter. Asked through
    // the shared predicate rather than as `!== "workspace"`, so that a third
    // key source added later stops being counted here by default instead of
    // silently landing on the operator's bill.
    if (tokens > 0 && billsTheOperator(keys)) {
      await deps.entitlements.record(connection.user_id, tokens);
    }

    return finish(connection, deps, startedAt, {
      // Nothing changed is not nothing happening. `skipped` is what stops a
      // healthy connection over an unchanged folder from reading as broken.
      status: added + updated + removed > 0 ? "ok" : "skipped",
      added,
      updated,
      removed,
      more,
      tokens,
      // One narrowing, not a standing exemption — but the whole of that one
      // narrowing. A 280-document removal is capped at twenty per run, and
      // clearing the approval after the first twenty would pause the
      // connection again on the next run and ask the same question of somebody
      // who has already answered it. So it is spent when the backlog is
      // drained, not when it is first used.
      clearApproval: approved && vanished.length <= MAX_REMOVALS_PER_RUN,
    });
  } catch (err) {
    // Same question as the success path above, asked the same way.
    if (tokens > 0 && billsTheOperator(keys)) {
      await deps.entitlements.record(connection.user_id, tokens);
    }

    const message = err instanceof Error ? err.message : String(err);
    const retryable = err instanceof ProviderError ? err.retryable : true;
    const limit = retryable ? MAX_TRANSIENT_FAILURES : MAX_FAILURES;
    const failures = connection.consecutive_failures + 1;

    return finish(connection, deps, startedAt, {
      status: "failed",
      added: 0,
      updated: 0,
      removed: 0,
      more: false,
      error: message,
      // A non-retryable failure — a revoked grant — pauses on the first one.
      // There is nothing to wait for, and five days of identical errors is not
      // more informative than one.
      pause: !retryable || failures >= limit ? message : undefined,
      // A non-retryable provider error is a revoked or removed grant, which is
      // a different thing to offer a person than "this has failed five times".
      pauseCode: !retryable ? "grant_revoked" : "repeated_failures",
      tokens,
    });
  }
}

/** Written to `connection_runs.error` when a run is skipped for quota. */
export const QUOTA_SKIP_REASON = "skipped: the owner's monthly token quota is used up";

/**
 * Re-attach documents this connection imported before it existed.
 *
 * Two paths lead here and both are ordinary. A workspace restored from an
 * export has its documents and a connection with no token (`export/sql.ts`
 * pauses it and says why); somebody reconnecting a source that was removed has
 * documents whose `connection_id` was nulled by the foreign key. In both cases
 * the external ids still match, and without this pass the next sync would
 * import a second copy of every file and leave the first copy behind as
 * unrefreshed noise.
 *
 * Scoped to the bundle, because that is the only claim being made: a document
 * in this bundle, carrying this file's id at the source, and belonging to no
 * connection, is this connection's document.
 */
async function adoptOrphans(
  connection: ConnectionRow,
  deps: SyncDeps,
  externalIds: string[],
): Promise<void> {
  if (externalIds.length === 0) return;
  const { error } = await deps.db
    .from("documents")
    .update({ connection_id: connection.id })
    .eq("bundle_id", connection.bundle_id)
    .is("connection_id", null)
    .in("external_id", externalIds);
  if (error) {
    // Not fatal. The worst case is a duplicate import, which is visible and
    // fixable; failing the whole sync over it would not be.
    console.error("connection orphan adoption failed", connection.id, error);
  }
}

/**
 * Hide the documents whose source file is no longer there.
 *
 * A mark, not a delete, and the bytes stay put — the same answer 0040 gave for
 * `DELETE /documents/:id`, and it matters more here rather than less. A person
 * deleting a document meant to; a folder that briefly stops listing a file
 * meant nothing, and a hard delete would spend somebody's thirty-day undo on a
 * Drive permission that changed for an afternoon. `runPurge` removes the row
 * and the object together when the thirty days are up.
 *
 * `deleted_by` is left null because nobody did this, and `deleted_via` is left
 * null on purpose too: 0040's rule is that a document hidden on its own does
 * not come back when its bundle is restored. That is the right answer for a
 * file the source no longer has.
 *
 * `document_chunks` are hidden by their document's flag rather than by their
 * own — `dc_select_member` joins to `documents.deleted_at` — so retrieval stops
 * at the same instant either way.
 */
async function removeVanished(
  deps: SyncDeps,
  /** Already filtered to the live documents the source no longer lists. */
  vanished: ExistingDocument[],
): Promise<number> {
  const gone = vanished.slice(0, MAX_REMOVALS_PER_RUN);
  if (gone.length === 0) return 0;

  const { data: hidden, error } = await deps.db
    .from("documents")
    .update({ deleted_at: deps.now().toISOString(), deleted_by: null, deleted_via: null })
    .in(
      "id",
      gone.map((d) => d.id),
    )
    .select("id");
  if (error) throw new Error(`could not remove deleted documents: ${error.message}`);

  return (hidden ?? []).length;
}

/** Read one remote file and make it a document, replacing what was there. */
async function importOne(
  connection: ConnectionRow,
  deps: SyncDeps,
  /** Whose key answers the embedding call below — house or the workspace's. */
  runEnv: SyncEnv,
  provider: ConnectionProvider,
  ctx: ProviderContext,
  file: RemoteFile,
  existing: ExistingDocument | undefined,
): Promise<{ imported: "added" | "updated" | "skipped"; tokens: number }> {
  const text = await provider.readFile(ctx, file);

  // The same gate the upload form applies, for the same reason: a document with
  // no readable text uploads successfully, is listed, is named to the model on
  // every turn, and is impossible to retrieve a sentence of. An empty Notion
  // page is the common case here and is not an error — it is skipped, and the
  // version is deliberately not recorded, so it imports itself the moment
  // somebody writes in it.
  if (!hasIndexableText(text)) return { imported: "skipped", tokens: 0 };

  const bytes = new TextEncoder().encode(text);
  const store = getDocStore(deps.env);
  const key = `${connection.bundle_id}/${crypto.randomUUID()}-${safeName(file.name)}`;
  await store.put(key, bytes.buffer as ArrayBuffer, { contentType: "text/plain; charset=utf-8" });

  const row = {
    name: file.name,
    size: bytes.byteLength,
    r2_key: key,
    content: text.slice(0, EXCERPT_LIMIT),
    external_version: file.version,
    external_url: file.url,
    synced_at: deps.now().toISOString(),
    // Clears the mark a previous run left when this file had gone from the
    // source. Without it the document would come back with fresh text and stay
    // invisible, which is the worst of both answers.
    deleted_at: null,
    deleted_by: null,
    deleted_via: null,
  };

  let documentId: string;
  let staleKey: string | null = null;

  if (existing) {
    const { data, error } = await deps.db
      .from("documents")
      .update(row)
      .eq("id", existing.id)
      .select("id")
      .single();
    if (error || !data) {
      await safeDelete(store, key);
      throw new Error(`could not update ${file.name}: ${error?.message ?? "no row"}`);
    }
    documentId = data.id;
    staleKey = existing.r2_key;
  } else {
    const { data, error } = await deps.db
      .from("documents")
      .insert({
        ...row,
        bundle_id: connection.bundle_id,
        connection_id: connection.id,
        external_id: file.externalId,
      })
      .select("id")
      .single();
    if (error || !data) {
      await safeDelete(store, key);
      throw new Error(`could not save ${file.name}: ${error?.message ?? "no row"}`);
    }
    documentId = data.id;
  }

  // Which bundle the passages belong to, which is the document's own and only
  // incidentally the connection's.
  //
  // A synced document can be moved like any other, and the move takes its
  // chunks with it precisely because retrieval reads scope from
  // `document_chunks.bundle_id` rather than from the document row. Writing
  // `connection.bundle_id` here undid that on the next version change: the row
  // stayed in the bundle somebody moved it to while its passages jumped back to
  // the connection's, so the document was listed in one bundle and retrievable
  // only through another — the exact split `PATCH /documents/:id` refuses to
  // create. The insert path has no document yet, so there the connection's
  // bundle is the answer.
  const passageBundleId = existing?.bundle_id ?? connection.bundle_id;

  // Embed before touching the stored chunks, so a failure never leaves the
  // document worse off than it was — the same order `POST /documents/:id/reindex`
  // uses, and the reason a half-synced document still answers questions.
  const chunks = chunkText(text);
  const embedded = await embedTexts(runEnv, chunks);
  const tokens = embeddingCost(embedded.tokens);

  const { error: clearError } = await deps.db
    .from("document_chunks")
    .delete()
    .eq("document_id", documentId);
  if (clearError) throw new Error(`could not clear old passages: ${clearError.message}`);

  const { error: chunkError } = await insertChunkRows(
    deps.db,
    chunks.map((content, index) => ({
      document_id: documentId,
      bundle_id: passageBundleId,
      workspace_id: connection.workspace_id,
      chunk_index: index,
      content,
      context: file.name,
      embedding: embedded.vectors[index],
    })),
  );
  if (chunkError) {
    throw new Error(`could not save passages for ${file.name}`);
  }

  if (staleKey && staleKey !== key) await safeDelete(store, staleKey);

  return { imported: existing ? "updated" : "added", tokens };
}

async function safeDelete(
  store: ReturnType<typeof getDocStore>,
  key: string | null,
): Promise<void> {
  if (!key) return;
  try {
    await store.delete(key);
  } catch (e) {
    console.error("document store delete failed", e);
  }
}

/**
 * Write the run row and the connection's next state.
 *
 * A failure backs the interval off geometrically and, at the limit, pauses with
 * the reason on the row — where the person looking at the connection will
 * actually read it, rather than in a log they do not have.
 */
async function finish(
  connection: ConnectionRow,
  deps: SyncDeps,
  startedAt: Date,
  outcome: SyncOutcome & {
    error?: string;
    pause?: string;
    /**
     * Required whenever `pause` is set, and that pairing is enforced by every
     * call site rather than by the type, because the type would have to be a
     * discriminated union for one field. The reason it matters: a pause with no
     * code reads, to the interface, exactly like a person having pressed Pause,
     * and the person would then be offered Resume for a revoked grant.
     */
    pauseCode?: PausedCode;
    tokens?: number;
    /** Clears an `access_narrowed` approval the run has now acted on. */
    clearApproval?: boolean;
  },
): Promise<SyncOutcome> {
  const finishedAt = deps.now();
  const intervalMs = connection.sync_interval_minutes * 60 * 1000;

  const failures = outcome.status === "failed" ? connection.consecutive_failures + 1 : 0;
  const backoff =
    outcome.status === "failed"
      ? Math.min(intervalMs * Math.pow(2, Math.min(failures, 10)), intervalMs + MAX_BACKOFF_MS)
      : outcome.more
        ? // Not a backoff: the run worked and ran out of budget. Coming straight
          // back is how a first sync of a large folder finishes at all.
          CONTINUE_SOON_MS
        : intervalMs;

  await deps.db.from("connection_runs").insert({
    connection_id: connection.id,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    status: outcome.status,
    documents_added: outcome.added,
    documents_updated: outcome.updated,
    documents_removed: outcome.removed,
    tokens: outcome.tokens ?? 0,
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    error: outcome.error ?? null,
  });

  await deps.db
    .from("connections")
    .update({
      last_sync_at: finishedAt.toISOString(),
      next_sync_at: new Date(finishedAt.getTime() + backoff).toISOString(),
      consecutive_failures: failures,
      claimed_at: null,
      status: outcome.pause ? "paused" : connection.status,
      paused_reason: outcome.pause ?? null,
      // Written together, always. The sentence is for a person and the code is
      // for the interface, and a row carrying one without the other is a row
      // that says two different things about the same pause.
      paused_code: outcome.pause ? (outcome.pauseCode ?? "repeated_failures") : null,
      // Spent, not kept. An approval is permission for one narrowing, not a
      // standing exemption — leaving it set would mean the next unexpected loss
      // of access went through without asking.
      ...(outcome.clearApproval ? { removals_approved_at: null } : {}),
      updated_at: finishedAt.toISOString(),
    })
    .eq("id", connection.id);

  return {
    status: outcome.status,
    added: outcome.added,
    updated: outcome.updated,
    removed: outcome.removed,
    more: outcome.more,
  };
}
