import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * What this conversation has already been offered, so a later turn does not
 * have to search again to be allowed to act.
 *
 * WHY. `ToolContext.offeredSlugs` is what `run_tool` refuses against, and it
 * was built fresh per turn. A conversation's third question rarely runs
 * `find_tool` — it asks about something the first question already found — so
 * the set was empty, the guard stood down, and an invented slug went out to
 * Composio and came back a billed 404. Fifteen of twenty-three `run_tool`
 * failures in the week of 2026-09-20 were exactly that.
 *
 * The fix is not a new store. `message_steps` already holds every earlier turn
 * of this conversation, already behind the same RLS door as the reply it
 * belongs to, and already works on both runtimes — which is more than a cache
 * in front of it could claim. `0066` added the one column that made the answer
 * exact rather than parsed out of a truncated excerpt.
 *
 * THE READ IS THE TENANT CHECK. This takes the caller's RLS-scoped client, not
 * `service_role`, and the session id comes from the route's own row rather than
 * from anything the model wrote. So a conversation can only ever be seeded from
 * itself: `message_is_visible` (0060) decides, in the database, exactly as it
 * does for the transcript. Nothing here compares a workspace id in application
 * code, because nothing here should be trusted to.
 *
 * That matters more than it looks. The memo keys these sets are built from
 * carry no workspace at all — `find-tool.ts` keys a search on
 * `toolkit|detail|named|query` — and the rendered values embed connection ids
 * and labels. Any store that outlived a turn on *those* keys would hand one
 * tenant another's connection ids. Reading back through the message row is what
 * keeps the boundary in Postgres.
 */

/**
 * How many prior steps to read back.
 *
 * A ceiling rather than the whole conversation, because this runs on the
 * critical path of every turn and a long session is unbounded. 200 steps is far
 * past any real conversation — the busiest session in production held 94
 * discovery steps in total — so in practice this truncates nothing, and it
 * stops a pathological session from turning one query into a large one.
 *
 * Newest first, so if it ever does bind, what survives is what the model was
 * offered most recently.
 */
const MAX_PRIOR_STEPS = 200;

/**
 * The operation slugs this session has already had put in front of it.
 *
 * Empty on any failure, and deliberately so: an empty set is exactly what this
 * code replaces, so a database that will not answer leaves the harness behaving
 * the way it did before this existed. The alternative — failing the turn
 * because an optimisation could not be primed — would trade a working reply for
 * a guard.
 */
export async function priorOfferings(db: SupabaseClient, sessionId: string): Promise<Set<string>> {
  try {
    const { data, error } = await db
      .from("message_steps")
      // `!inner` so the filter on the parent row is a join rather than a second
      // round trip; every step has a message, so it drops nothing.
      .select("offered, messages!inner(session_id)")
      .eq("messages.session_id", sessionId)
      .not("offered", "is", null)
      .order("created_at", { ascending: false })
      .limit(MAX_PRIOR_STEPS);

    if (error) {
      // Logged and swallowed, on `writeSteps`' reasoning: a reply that arrives
      // is worth more than the guard in front of it.
      console.error("failed to read prior offerings", error);
      return new Set();
    }

    const slugs = new Set<string>();
    for (const row of data ?? []) {
      for (const slug of (row as { offered?: string[] | null }).offered ?? []) {
        slugs.add(slug);
      }
    }
    return slugs;
  } catch (err) {
    // The column not existing yet is the case this is really for: `0066` has to
    // be applied by hand (CI applies migrations only in its RLS job), so a
    // deployment can run this code against a schema without it. PostgREST
    // answers that with an error rather than a throw, but a client that cannot
    // reach the database at all throws — and neither is worth a failed reply.
    console.error("failed to read prior offerings", err);
    return new Set();
  }
}
