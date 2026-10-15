import type { Context } from "hono";
import type { AppEnv, Bindings } from "../../types";
import { TURN_HEADER, turnOfRequest, type TurnStart, type TurnStatus } from "./detached";
import { followFrom, followLocally } from "./follow";
import { localTurn, startLocalTurn } from "./local";

export { TURN_HEADER, captureRequest, type TurnStart } from "./detached";

/**
 * Where a conversation's turn runs, and how anybody else reaches it.
 *
 * The same four questions on both runtimes — start one, is one running, show
 * me it, stop it — answered in this process on Node and by the conversation's
 * Durable Object on Cloudflare. A route asks `turnHost` and never learns which:
 * the same rule `lib/defer.ts` and `lib/docstore/` keep for the rest of the
 * runtime-specific code.
 */
export interface TurnHost {
  /** Start the turn, answering with the route's own response or a subscription. */
  start(start: TurnStart): Promise<Response>;
  /** The conversation's turn, running or just finished; null when there is none. */
  status(sessionId: string): Promise<TurnStatus | null>;
  /** The turn from its first event, or null when there is none. */
  stream(sessionId: string): Promise<Response | null>;
  /** Stop the turn if it is this person's; false when nothing was running. */
  stop(sessionId: string, userId: string): Promise<"stopped" | "idle" | "forbidden">;
}

/** How a replayed request reaches the app on Node. */
export type AppFetch = (
  request: Request,
  env: Bindings,
  ctx: ExecutionContext,
) => Promise<Response>;

/**
 * The host this deployment runs turns on, or null where turns stay with their
 * request.
 *
 * - **Cloudflare with `TURN_ROOMS` bound**: the conversation's Durable Object.
 * - **Node** (`PEER_ADDR` is how this codebase tells — see `Bindings`): this
 *   process, which outlives every request already.
 * - **Cloudflare without the binding**: null, and a turn behaves exactly as it
 *   did before any of this — it lives and dies with its request. A deploy that
 *   has not added the binding yet loses nothing it had.
 *
 * `fetchApp` is only needed to start a turn on Node, which replays the request
 * against the app in this process; reading, streaming and stopping one do not.
 */
export function turnHost(env: Bindings, fetchApp?: AppFetch): TurnHost | null {
  if (env.TURN_ROOMS) return durableHost(env.TURN_ROOMS);
  if (env.PEER_ADDR !== undefined) return localHost(env, fetchApp);
  return null;
}

/**
 * The signal a turn's model calls and tools are given.
 *
 * A replayed turn's own, which only `stop` aborts; otherwise the request's,
 * which is how a turn on a host-less deployment still ends with its tab.
 */
export function turnSignal(c: Context<AppEnv>): AbortSignal {
  return turnOfRequest(c.req.header(TURN_HEADER))?.signal ?? c.req.raw.signal;
}

/**
 * Whether this request is a turn being replayed by its host, rather than one
 * arriving from a browser. Read by the middleware that must not act twice on
 * the same turn: the limiter, and the detaching itself.
 */
export function isReplayedTurn(c: Context<AppEnv>): boolean {
  return turnOfRequest(c.req.header(TURN_HEADER)) !== undefined;
}

/**
 * Whether the turn ending now ended because a person pressed stop.
 *
 * The route's abort path used to mean "the tab closed"; with a host it means
 * only this, so the reply it keeps can say it was stopped (`stopped`, 0101)
 * rather than looking finished.
 */
export function stoppedByPerson(c: Context<AppEnv>): boolean {
  return turnOfRequest(c.req.header(TURN_HEADER))?.stopped ?? false;
}

/**
 * Cloudflare's guess at the caller's timezone, wherever the turn is running.
 * A replay is not a request from the edge and has no `cf`; the host carried it.
 */
export function visitorTimezone(c: Context<AppEnv>): string | undefined {
  const own = (c.req.raw as { cf?: { timezone?: string } }).cf?.timezone;
  return own ?? turnOfRequest(c.req.header(TURN_HEADER))?.timezone;
}

function localHost(env: Bindings, fetchApp: AppFetch | undefined): TurnHost {
  return {
    async start(start) {
      if (!fetchApp) throw new Error("starting a turn needs the app to replay it against");
      const started = startLocalTurn(start, (req, ctx) => fetchApp(req, env, ctx));
      if (started.kind === "busy") {
        return Response.json({ error: "a reply is already being written" }, { status: 409 });
      }
      // Then the browser the turn may have started — see `lib/turns/follow.ts`.
      void started.turn.finished.then(() => followLocally(env, followFrom(start)));
      return started.turn.response();
    },
    async status(sessionId) {
      return localTurn(sessionId)?.status() ?? null;
    },
    async stream(sessionId) {
      const turn = localTurn(sessionId);
      if (!turn) return null;
      return new Response(turn.subscribe(), {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    },
    async stop(sessionId, userId) {
      const turn = localTurn(sessionId);
      if (!turn?.running) return "idle";
      if (turn.userId !== userId) return "forbidden";
      await turn.stop();
      return "stopped";
    },
  };
}

function durableHost(rooms: DurableObjectNamespace): TurnHost {
  const room = (sessionId: string) => rooms.get(rooms.idFromName(sessionId));
  const at = (path: string, params: Record<string, string>) =>
    `https://turn-room${path}?${new URLSearchParams(params).toString()}`;

  return {
    async start(start) {
      const res = await room(start.sessionId).fetch(at("/start", {}), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(start),
      });
      return mutable(res);
    },
    async status(sessionId) {
      const res = await room(sessionId).fetch(at("/status", { session: sessionId }));
      return res.ok ? ((await res.json()) as TurnStatus | null) : null;
    },
    async stream(sessionId) {
      const res = await room(sessionId).fetch(at("/stream", { session: sessionId }));
      return res.status === 204 ? null : mutable(res);
    },
    async stop(sessionId, userId) {
      const res = await room(sessionId).fetch(at("/stop", { session: sessionId, user: userId }), {
        method: "POST",
      });
      if (res.status === 403) return "forbidden";
      const body = (await res.json().catch(() => ({}))) as { stopped?: boolean };
      return body.stopped ? "stopped" : "idle";
    },
  };
}

/**
 * A response from another object, rebuilt so this Worker's middleware may add
 * its own headers to it — CORS, chiefly. A stub's response has immutable
 * headers, and Hono writes to them after the handler returns.
 */
function mutable(res: Response): Response {
  return new Response(res.body, { status: res.status, headers: new Headers(res.headers) });
}
