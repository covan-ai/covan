import type { RoutineEnv } from "./../types";
import { canSyncConnections } from "./../types";
import { runDueRoutines } from "./routines/dispatcher";
import { runDueConnections } from "./connections/dispatcher";
import { pollDueBrowserTasks } from "./browser/poller";
import { sweepHeldRuns } from "./routines/held";
import { sweepEventSubscriptions } from "./routines/events/lifecycle";
import { startQueuedBrowserTasks } from "./browser/queue";
import { sweepAbandonedTakeovers, sweepConversationBrowsers } from "./browser/sweep";
import { PROVIDERS } from "./connections/registry";
import { advanceDueDocumentJobs } from "./docs/host";
import { advanceDueIndexJobs } from "./indexing/host";
import { syncPassageVectors } from "./passages";

/**
 * One scheduled tick, for both Workers that have one.
 *
 * There are two kinds of background work now — routines deliver, connections
 * sync — and one cron trigger to run them on. This is where the two are
 * sequenced, in one place, because the sequencing is the interesting part.
 *
 * **They do not both run.** A routine tick can spend up to 49 subrequests and a
 * connection sync up to 45, against the 50 a Cloudflare Free invocation gets.
 * Running them back to back would not fail cleanly: the first would work and
 * the second would die partway through, so a workspace would see its routines
 * deliver and its Drive quietly stop syncing, which is the worst of the
 * available failures because it looks like a connector bug rather than a
 * platform limit.
 *
 * So a tick does routines, and only reaches the connections if there were no
 * routines due. Routines are the latency-sensitive half — somebody asked for a
 * digest at 9am — and connections are the patient half, measured in hours. On
 * any realistic schedule the idle ticks vastly outnumber the busy ones, so a
 * connection waits for the next quiet minute rather than for a free hour.
 *
 * On Workers Paid, where the limit is 10,000, this could simply be both. It is
 * written as an either/or because the open build has to work on Free — a
 * self-hoster's first deploy is the one that has to not need a plan upgrade.
 */
export async function runScheduledWork(env: RoutineEnv): Promise<void> {
  const routines = await runDueRoutines(env);
  if (routines.claimed > 0) return;

  /**
   * Abandoned takeovers first, and the order is the whole point.
   *
   * This file is strictly either/or — each stage returns if it claimed
   * anything, for the subrequest arithmetic above. A sweep placed last would
   * never run on a deployment with steady routines or a browser-task backlog,
   * which is precisely the busy deployment where takeovers happen.
   *
   * And what it protects is not tidiness. A takeover's provider session saves
   * the cookie jar only when something stops it explicitly — browser-use:
   * *"if a session is left open or times out, changes may not be persisted"* —
   * so a person who closed the tab instead of pressing done loses the login
   * they just performed unless this runs. An idle tick costs one subrequest:
   * the claim, answering nothing.
   */
  const takeovers = await sweepAbandonedTakeovers(env);
  if (takeovers.claimed > 0) return;

  /**
   * The same safety net for the browser beside a conversation: somebody took
   * its controls and never pressed Done, or nobody is using it any more and it
   * is still open at the provider (ruling R20). Both arms come from one claim
   * in one batch. Same stage, same reason, same either/or — it is reached only
   * when the takeover sweep claimed nothing, so the two never share a tick's
   * subrequests (`sweepConversationBrowsers` does that arithmetic: 42 of 50 at
   * worst, these two claims included). The price is that an idle tick spends
   * two subrequests here, the two claims, rather than one.
   */
  const conversations = await sweepConversationBrowsers(env);
  if (conversations.claimed > 0) return;

  /**
   * Browser tasks, between routines and connections.
   *
   * The order is the design doc's, and the trade-off is real: a deployment
   * whose routines fill every tick never reaches this, so a browser answer
   * waits. Routines are the half somebody scheduled for a specific minute; a
   * browser task is already minutes old by the time it finishes and its
   * person has been told to expect "a few minutes". An idle tick costs one
   * subrequest here — the claim, answering nothing — which is why this sits
   * above the connection sync rather than below it.
   */
  /**
   * Browser tasks waiting their turn (0080), just above the poll. A settle
   * starts what is behind it when it can; this is for the rest — a line a
   * take-over or a sign-in held and has let go of, a start that has to be
   * tried again, and every start on Free, where the poll's settles leave it
   * here. An idle tick costs two subrequests: the expiry and the claim.
   */
  const queue = await startQueuedBrowserTasks(env);
  if (queue.started > 0 || queue.expired > 0) return;

  const browser = await pollDueBrowserTasks(env);
  if (browser.claimed > 0) return;

  // A routine's report that waited on its browser longer than it should
  // (0100) — sent with what it has. Last of the browser stages, because every
  // stage above is one that might still answer it.
  const held = await sweepHeldRuns(env);
  if (held.finished > 0) return;

  // Event subscriptions out of step with their routines (0109): a subscribe
  // that failed and is due another try, an arrangement about to lapse, a
  // routine paused or binned whose provider is still sending, one restored
  // whose provider has stopped. Up to three, a handful of subrequests each;
  // an idle tick costs the one claim. Below the browser stages because none
  // of this is waiting on a person, and above the documents because a lapsed
  // Drive channel is an event somebody will not get.
  const events = await sweepEventSubscriptions(env);
  if (events.claimed > 0) return;

  // Documents whose clock stopped: no Durable Object bound, nobody watching
  // the tab, a worker that died holding the lease. One unit per job, two jobs
  // at most — a unit is one model call and a few writes, so this stays inside
  // a Free tick. An idle tick costs one subrequest, the claim. On the cron
  // Worker (no document store) a job that is ready to be filed is put back for
  // the API Worker; see `advanceDocumentJob`.
  if (await advanceDueDocumentJobs(env)) return;

  // The passage index (0116), where one is bound: what was deleted or moved
  // since the last tick, then the next pages of embeddings still in the
  // column. Unbound, it returns before asking anything. Above the indexing
  // below, because a deleted passage the index still answers with costs a
  // slot in every search of its bundle until it is told.
  if (await syncPassageVectors(env)) return;

  // Documents whose indexing nobody is driving (0105): no Durable Object bound,
  // or a host that died holding the lease. Only where there is a document store
  // to read the file from; one unit per document, two documents at most, and
  // an idle tick costs the one claim.
  if (canSyncConnections(env) && (await advanceDueIndexJobs(env))) return;

  if (!canSyncConnections(env)) {
    // Not an error, and not silent either. This is the cron-only Worker
    // deployed without a document store, which is exactly how it shipped before
    // connections existed — it can deliver routines and cannot write documents.
    // Said once per idle tick so an operator wondering why Notion never syncs
    // finds the answer in `wrangler tail` rather than in the database.
    console.warn(
      "connections not synced: this Worker has no document storage bound (DOCS or DOCS_DIR)",
    );
    return;
  }

  // The same question again, about the other half of what a sync needs — and it
  // has to be asked *here*, before anything is claimed, because of what happens
  // downstream if it is not.
  //
  // `sync.ts` also checks `isConfigured`, and when it fails there the
  // connection is **paused**, with a message telling the person an operator has
  // to set the client credentials. That is the right answer to the question it
  // thinks it is answering — "this deployment stopped offering Notion" — and
  // the wrong answer to the one that actually arises here: "this *Worker* was
  // deployed without credentials the deployment does have". The two are
  // indistinguishable from inside a single env, and they are not equally
  // costly. Guessing "removed" when the truth is "not on this Worker" pauses
  // every connection in every workspace and blames the operator for it;
  // guessing the other way leaves a source a little stale.
  //
  // So a Worker that cannot configure any provider claims nothing at all, and
  // says why, exactly as it does for the document store above. A deployment
  // that really has removed a provider still tells people so, in the place that
  // is designed to say it — the Integrations page lists an unconfigured source
  // with the variables that would turn it on, rather than hiding it.
  if (!PROVIDERS.some((provider) => provider.isConfigured(env))) {
    console.warn(
      "connections not synced: no source has its OAuth client credentials on this Worker " +
        "(NOTION_CLIENT_ID/NOTION_CLIENT_SECRET, GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)",
    );
    return;
  }

  await runDueConnections(env);
}
