import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";
import { captureRequest, isReplayedTurn, turnHost, type AppFetch } from "../lib/turns";

/**
 * Hand a chat turn to its host before the route runs, so it outlives the tab.
 *
 * In front of the two routes that run a turn — `POST /chat/stream` and `POST
 * /chat/confirm/:id` — and after authentication and the `expensive` limiter,
 * so a turn is refused, counted and attributed exactly once, here, on the
 * request the browser sent. The host then replays that request against the
 * same app; the replay reaches this middleware again and is let through to
 * the route (`isReplayedTurn`).
 *
 * Steps aside, and leaves the route to answer, whenever it cannot name the
 * conversation: a malformed body or an unknown paused turn is the route's 400
 * or 404 to give, with the wording it already has.
 */
export function detachTurn(fetchApp: AppFetch): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isReplayedTurn(c)) return next();
    const host = turnHost(c.env, fetchApp);
    if (!host) return next();

    const body = await c.req.text();
    const sessionId = await sessionOfTurn(c, body);
    if (!sessionId) return next();

    return host.start({
      sessionId,
      userId: c.get("user").id,
      request: await captureRequest(c.req.raw, body),
    });
  };
}

/**
 * Which conversation a turn request is about.
 *
 * Read through the caller's own client for a paused turn, so a conversation
 * they cannot see is not one they can occupy a host for: the route would
 * refuse them anyway, but only after the host had started.
 */
async function sessionOfTurn(c: Context<AppEnv>, body: string): Promise<string | null> {
  const pausedId = c.req.param("id");
  if (pausedId) {
    const { data } = await c
      .get("db")
      .from("paused_turns")
      .select("session_id")
      .eq("id", pausedId)
      .maybeSingle();
    return typeof data?.session_id === "string" ? data.session_id : null;
  }
  try {
    const parsed = JSON.parse(body) as { sessionId?: unknown };
    return typeof parsed.sessionId === "string" && parsed.sessionId.length > 0
      ? parsed.sessionId
      : null;
  } catch {
    return null;
  }
}
