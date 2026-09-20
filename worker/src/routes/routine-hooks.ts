import { Hono } from "hono";
import type { AppEnv } from "../types";
import { deferred } from "../lib/defer";
import { getRateLimiter } from "../lib/ratelimit";
import { readCapped } from "../lib/routines/source";
import { resolveIngestToken, touchTrigger } from "../lib/routines/ingest";
import { runPokedRoutine } from "../lib/routines/dispatcher";

/**
 * `POST /routine-hooks/:token` — somebody else's system, starting a routine.
 *
 * The URL shape is the feature. It has to be one string that can be pasted
 * into GitHub's webhook box, Stripe's dashboard, a Zapier step or a `curl` in
 * a CI job, by somebody who will not be adding a header — so the token lives
 * in the path. `X-Covan-Ingest-Token` is accepted and wins when both are
 * present, for the senders that do let you set a header and for anybody who
 * would rather their token stayed out of a URL.
 *
 * Unauthenticated in the Covan sense: there is no session and no `auth.uid()`,
 * which is why the lookup is in `lib/routines/ingest.ts` behind the service
 * role. What stands in for a caller is the token, and what the token grants is
 * one permission on one row — see that file for why it is deliberately not
 * turned into a session for the routine's owner.
 */
export const routineHooks = new Hono<AppEnv>();

/**
 * How much body is read before the connection is dropped.
 *
 * A webhook payload is a description of something that happened, and 64 KB is
 * a great deal of that. The limit exists because the sender chooses the size
 * and this endpoint is reachable by anybody holding one token: without it, one
 * routine's leaked token is a way to spend the Worker's memory. The stream is
 * cancelled at the cap rather than read to the end and measured.
 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * The headers a sender's own event id may arrive in, in the order they are
 * trusted.
 *
 * `X-Covan-Event-Id` is ours and wins. `Idempotency-Key` is the convention
 * most APIs settled on. `X-GitHub-Delivery` is here because GitHub is the
 * sender this endpoint will see most and it will not be setting either of the
 * other two.
 */
const EVENT_ID_HEADERS = ["X-Covan-Event-Id", "Idempotency-Key", "X-GitHub-Delivery"];

routineHooks.post("/routine-hooks/:token", async (c) => {
  // Cheap refusal first, for a sender that announced the size. The streaming
  // cap below is the real guard — `Content-Length` is a claim, not a fact.
  const announced = Number(c.req.header("Content-Length") ?? "");
  if (Number.isFinite(announced) && announced > MAX_BODY_BYTES) {
    return c.json({ error: "payload too large" }, 413);
  }

  let payload: string;
  try {
    payload = await readCapped(c.req.raw, MAX_BODY_BYTES);
  } catch {
    return c.json({ error: "payload too large" }, 413);
  }

  // The header wins over the path so a sender that can set one is not forced
  // to put its credential in a URL that ends up in somebody's access log.
  const token = c.req.header("X-Covan-Ingest-Token") ?? c.req.param("token");
  const resolved = await resolveIngestToken(c.env, token);
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);

  const routine = resolved.routine;

  // Counted per routine, not per address.
  //
  // An address is the wrong key in both directions here. One sender behind one
  // address — which is what a webhook is — would be counted as many if several
  // routines shared it, and many senders behind one NAT would be counted as
  // one. The routine is the thing being protected: it is the row that spends
  // its owner's allowance every time this fires.
  const verdict = await getRateLimiter(c.env, "expensive").check(`routine-hook:${routine.id}`);
  if (!verdict.allowed) {
    c.header("Retry-After", String(verdict.retryAfterSeconds));
    return c.json({ error: "rate_limited" }, 429);
  }

  // No id from the sender means no way to deduplicate, so nothing pretends
  // otherwise: a fresh id makes this run, which is what somebody who poked an
  // endpoint expects. Inventing one by hashing the body would be worse than
  // useless — two genuine "the deploy finished" events are identical, and
  // would silently become one.
  const eventId =
    EVENT_ID_HEADERS.map((h) => c.req.header(h)).find((v) => v && v.trim()) ??
    crypto.randomUUID();

  // 202 now, work afterwards. A routine run reads documents, calls a model and
  // delivers, which is tens of seconds; every webhook sender worth the name
  // times out long before that and retries, and a retry of something already
  // running is how one poke becomes four. The run is idempotent on `eventId`
  // regardless — this just means the sender is not the one discovering it.
  deferred(
    c,
    (async () => {
      try {
        await runPokedRoutine(c.env, routine, { eventId: eventId.trim(), payload });
      } catch (err) {
        // The run records its own failure on `routine_runs`, which is where
        // the owner looks. This catch exists so an unhandled rejection cannot
        // take the isolate down with it.
        console.error("poked routine failed", err);
      }
      await touchTrigger(c.env, routine.id);
    })(),
  );

  // `deliveryId` is the sender's own id when it gave us one, so a sender that
  // logs this response can match it against what it sent.
  return c.json({ accepted: true, eventId: eventId.trim() }, 202);
});
