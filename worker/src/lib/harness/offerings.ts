import type { SupabaseClient } from "@supabase/supabase-js";
import { searchMemoKey } from "./tools/find-tool";

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
 *
 * `priorSearches` below reads the same rows on exactly those keys, and is safe
 * for exactly this reason: it is not a store that outlives a turn, it is a read
 * of this conversation's own steps, rebuilt every turn through the caller's own
 * client. The key never leaves the turn it was built in.
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

/**
 * The searches this conversation has already paid for, and what each offered.
 *
 * WHY. `find_tool` memoises a repeat inside one turn and nothing carried that
 * across turns, so a conversation's second question re-ran the first's search
 * byte for byte to be handed candidates it was already allowed to call. The
 * measurement (covan#216): 94 discovery steps, 24 byte-identical repeats, 20 of
 * them in a later turn, 80,368 characters bought twice. The one time it was
 * watched live, the repeat recorded `offered = NULL` — every candidate it came
 * back with was already in the seeded set. It bought nothing at all.
 *
 * WHY NO NEW COLUMN. Both halves are already on disk: `request` is the
 * arguments the step was called with, which is what `searchMemoKey` keys on,
 * and `offered` (0066) is the slugs it put in front of the model. So this is a
 * read, not a schema change, and the 500 MB ceiling does not move.
 *
 * WHY SLUGS AND NOT THE ANSWER. The rendered answer is not recoverable:
 * `result_excerpt` is capped at `MAX_STEP_EXCERPT_CHARS` and 45 of 61 stored
 * `find_tool` results exceeded it, so replaying one would show the first
 * candidates and silently lose the last. A memo that is sometimes short by two
 * operations is worse than searching again, which is why #214 shipped the slug
 * seeding and left this. The recall therefore rebuilds a short answer around
 * the slugs rather than pretending to recover the long one.
 *
 * ONLY A ROW THAT CAN BE SHOWN TO BE WHOLE. `offered` holds everything a search
 * showed, but it has not always: until `ToolResult.offered` it held only what
 * the step ADDED to the allowed set. A search whose best candidates an earlier,
 * different search had already offered therefore recorded its leftovers. Seen
 * in production: a search showed four operations, three of them offered minutes
 * before by a search in other words, and recorded the fourth — its worst match.
 * A turn later the recall named that one as what the search had found, the
 * model ran it, and three calendar events were created on the wrong day.
 *
 * Nothing on a row says which kind it is, so two things are taken as proof:
 *
 *   - nothing had been offered before it. There was nothing to leave out, so
 *     the addition and the whole are the same list;
 *   - it names a slug an earlier row already offered. The old record never
 *     did — that is exactly what it left out — so this row was written whole.
 *
 * Any other row is passed over. That costs a conversation one search it might
 * not have needed, and the search made instead records the whole answer, which
 * names what the passed-over row did and so is recalled from then on.
 *
 * ONE SEARCH, ONE KEY, THE NEWEST WHOLE ROW. Each such row is a complete
 * answer in the order the search ranked it, which is the order the model picks
 * from — so a later one replaces an earlier one rather than being appended to
 * it. A repeat answered from the turn's memo or from here records
 * `offered = NULL` and replaces nothing, so the answer of a key stays the last
 * search that was really made.
 *
 * A key with no such row is dropped rather than remembered as "found nothing":
 * a fruitless search is the useful kind of repeat — `find-tool.ts` says so
 * where it declines to memoise one — and the shortened retry depends on being
 * allowed to run again.
 *
 * Empty on any failure, on `priorOfferings`' reasoning: this is an
 * optimisation, and a database that will not answer should cost a search, not a
 * reply.
 */
export async function priorSearches(
  db: SupabaseClient,
  sessionId: string,
): Promise<Map<string, string[]>> {
  const searches = new Map<string, string[]>();
  try {
    const { data, error } = await db
      .from("message_steps")
      .select("request, offered, messages!inner(session_id)")
      .eq("messages.session_id", sessionId)
      // Narrowed in the database rather than here, and not for tidiness:
      // `request` holds whatever arguments a tool was called with — an
      // `http_request` body, a `query_database` statement — and this is the one
      // read that selects that column. It is entitled to `find_tool`'s
      // arguments and to nothing else, so nothing else is fetched.
      .eq("tool", "find_tool")
      // A failed or refused step answered nothing worth recalling, and a
      // `pending` one is a parked call whose answer has not happened yet.
      .eq("status", "ok")
      .order("created_at", { ascending: false })
      .limit(MAX_PRIOR_STEPS);

    if (error) {
      console.error("failed to read prior searches", error);
      return searches;
    }

    // Reversed: newest-first is what makes the ceiling above keep the most
    // recent searches, and oldest-first is what lets each row be judged against
    // what the conversation had been offered before it.
    const before = new Set<string>();
    for (const row of [...(data ?? [])].reverse()) {
      const step = row as { request?: unknown; offered?: string[] | null };
      const offered = step.offered ?? [];
      // Whether this row can be shown to hold all the search showed. Decided
      // before the row is counted among what came before.
      const whole = before.size === 0 || offered.some((slug) => before.has(slug));
      for (const slug of offered) before.add(slug);
      if (offered.length === 0 || !whole) continue;
      const request = (
        step.request && typeof step.request === "object" ? step.request : {}
      ) as Record<string, unknown>;
      // A step with no usable query cannot be the same search as anything: the
      // tool refuses that call before it searches, so there is nothing to
      // recall. Skipped rather than keyed on the empty string, which would
      // collide every unkeyable row into one entry.
      if (typeof request.query !== "string" || !request.query.trim()) continue;
      searches.set(searchMemoKey({ ...request, query: request.query }), [...new Set(offered)]);
    }
    return searches;
  } catch (err) {
    // Same as `priorOfferings`: a client that cannot reach the database throws
    // rather than answering, and that is not worth a failed reply either.
    console.error("failed to read prior searches", err);
    return searches;
  }
}
