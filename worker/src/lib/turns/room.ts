import type { Bindings } from "../../types";
import type { DetachedTurn, TurnStart } from "./detached";
import { FOLLOW_EVERY_MS, followFrom, followOnce, type Follow } from "./follow";
import { localTurn, startLocalTurn } from "./local";

/**
 * The Durable Object that holds a conversation's turn on Cloudflare.
 *
 * A Worker invocation ends with its request: once the caller disconnects, all
 * that survives is `waitUntil`, for thirty seconds — less than a tool turn
 * takes. An alarm handler is the one Cloudflare invocation nobody is connected
 * to, and it may run for fifteen minutes, so the turn runs inside one: `/start`
 * parks what to run and sets an alarm for now, the alarm runs it, and `/start`
 * answers its caller with a subscription to it. Every request about the same
 * conversation reaches the same object (`idFromName(sessionId)`), which is
 * what lets a browser that comes back find the turn it left.
 *
 * Inside the object the turn is an ordinary `DetachedTurn`, the same one Node
 * runs in-process — `lib/turns/local.ts` is the registry in both places. The
 * object adds the lifetime and nothing else.
 *
 * A factory rather than a class, because the turn is the API answering a
 * replayed request and the API is `app` in `index.ts`, which is also where
 * this class has to be exported from for Cloudflare to find it.
 */

type AppFetch = (request: Request, env: Bindings, ctx: ExecutionContext) => Promise<Response>;

/** The storage key of the turn `/start` parked for the alarm. */
const PENDING = "pending";
/** The storage key of the browser run a finished turn is being followed for. */
const FOLLOW = "follow";

/** How long `/start` waits for the alarm to pick its turn up. */
const PICKUP_MS = 15_000;

export function turnRoom(fetchApp: AppFetch) {
  return class TurnRoom implements DurableObject {
    private readonly state: DurableObjectState;
    private readonly env: Bindings;
    /** Callers of `/start` waiting for the alarm to hand them their turn. */
    private waiting: ((turn: DetachedTurn | null) => void)[] = [];

    constructor(state: DurableObjectState, env: Bindings) {
      this.state = state;
      this.env = env;
    }

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const sessionId = url.searchParams.get("session") ?? "";

      if (url.pathname === "/start" && request.method === "POST") {
        const start = (await request.json()) as TurnStart;
        if (localTurn(start.sessionId)?.running) return busy();
        await this.state.storage.put(PENDING, start);
        await this.state.storage.setAlarm(Date.now());
        const turn = await this.pickUp();
        if (!turn) return busy();
        return turn.response();
      }

      const turn = localTurn(sessionId);
      if (url.pathname === "/status") {
        return Response.json(turn ? turn.status() : null);
      }
      if (url.pathname === "/stream") {
        if (!turn) return new Response(null, { status: 204 });
        return new Response(turn.subscribe(), {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      }
      if (url.pathname === "/stop" && request.method === "POST") {
        if (!turn?.running) return Response.json({ stopped: false });
        if (turn.userId !== url.searchParams.get("user")) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        await turn.stop();
        return Response.json({ stopped: true });
      }
      return new Response("not found", { status: 404 });
    }

    /**
     * One alarm, two jobs: run the turn `/start` parked, or take one more look
     * at the browser a finished turn left running (`lib/turns/follow.ts`). An
     * object has a single alarm, so a new turn simply replaces a pending look,
     * and the follow is scheduled again once that turn has finished.
     */
    async alarm(): Promise<void> {
      const start = await this.state.storage.get<TurnStart>(PENDING);
      if (start) {
        // Deleted before running, never after: an alarm that throws is
        // retried, and a retry that found the turn still parked would answer
        // the same question twice — tools, emails and all.
        await this.state.storage.delete(PENDING);
        const started = startLocalTurn(start, (req, ctx) => fetchApp(req, this.env, ctx));
        const turn = started.kind === "started" ? started.turn : null;
        for (const resolve of this.waiting.splice(0)) resolve(turn);
        if (!turn) return;
        // Held open until the turn has finished, which is the whole reason the
        // turn is here: the alarm is the invocation that keeps it alive.
        await turn.finished.catch((err) => console.error("a turn ended badly", err));
        await this.state.storage.put(FOLLOW, followFrom(start));
        await this.state.storage.setAlarm(Date.now() + FOLLOW_EVERY_MS);
        return;
      }

      const follow = await this.state.storage.get<Follow>(FOLLOW);
      if (!follow) return;
      if (await followOnce(this.env, follow)) {
        await this.state.storage.setAlarm(Date.now() + FOLLOW_EVERY_MS);
      } else {
        await this.state.storage.delete(FOLLOW);
      }
    }

    private pickUp(): Promise<DetachedTurn | null> {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.waiting = this.waiting.filter((w) => w !== settle);
          resolve(null);
        }, PICKUP_MS);
        const settle = (turn: DetachedTurn | null) => {
          clearTimeout(timer);
          resolve(turn);
        };
        this.waiting.push(settle);
      });
    }
  };
}

function busy(): Response {
  return Response.json({ error: "a reply is already being written" }, { status: 409 });
}
