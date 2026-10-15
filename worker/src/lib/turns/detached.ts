/**
 * A chat turn that runs to the end whether or not anybody is still watching.
 *
 * Until this existed a turn lived inside the request that asked for it: the
 * model loop ran in `POST /chat/stream`'s response body, and the request's
 * abort signal reached every model call and every tool. So the turn ended when
 * the connection did — closing the tab, or only opening another conversation,
 * whose unmount aborts the fetch — and a half-written answer, a browser task
 * that had not yet been handed to the provider, a tool call halfway through,
 * all stopped with it.
 *
 * WHAT THIS DOES INSTEAD. The request is replayed, unchanged, against the same
 * app, by something that does not belong to the caller: a `DetachedTurn`. It
 * owns the abort signal the route sees (`turnSignal`), keeps every byte of the
 * SSE body it produces, and hands that body to whoever subscribes — the
 * browser that asked, and later the same browser coming back to the
 * conversation, which is shown the whole turn again from its first event. The
 * caller disconnecting closes a subscription and nothing else.
 *
 * Replaying the request rather than calling the turn as a function is the
 * point. `routes/chat.ts` is two routes and fifteen hundred lines of decisions
 * about a request — whose session it is, who pays, what the model is shown —
 * and every one of them still runs, as written, on a request that still has
 * its caller's token. Nothing about a turn changed except who holds it.
 *
 * WHERE IT RUNS is somebody else's question (`lib/turns/index.ts`): in this
 * process on Node, where the process outlives the request anyway, and in a
 * Durable Object's alarm on Cloudflare, where nothing else may outlive one.
 */

/** The request header that marks a replayed turn. Its value is the turn's key. */
export const TURN_HEADER = "X-Covan-Turn";

/** How long a finished turn stays readable, for a browser that reconnects late. */
export const LINGER_MS = 60_000;

/** How long `stop` waits for the turn to save what it had. */
const STOP_WAIT_MS = 15_000;

/** The parts of a request that are replayed — a body has already been read once. */
export type TurnRequest = {
  url: string;
  method: string;
  headers: [string, string][];
  body: string;
  /**
   * Cloudflare's guess at the caller's timezone, from `request.cf`. Carried
   * across because the replay is not a request from the edge and has no `cf`
   * of its own, and the prompt reads it — see `visitorZone` in `routes/chat.ts`.
   */
  timezone?: string;
};

/** What starting a turn needs to know: which conversation, and on whose behalf. */
export type TurnStart = {
  sessionId: string;
  userId: string;
  request: TurnRequest;
};

/** How a replayed request reaches the app. `app.fetch`, with its env bound. */
export type TurnFetch = (request: Request, ctx: ExecutionContext) => Promise<Response>;

/** What anybody outside the turn may be told about it. */
export type TurnStatus = {
  running: boolean;
  userId: string;
  startedAt: number;
};

/**
 * The headers that are not replayed: a length that will be recomputed, the
 * hop-by-hop ones, and a turn key the caller may have sent — only a key this
 * process minted may mark a request as a replay.
 */
const DROPPED = new Set([
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "host",
]);

/** Read a request into the shape `DetachedTurn` replays. */
export async function captureRequest(raw: Request, body: string): Promise<TurnRequest> {
  const headers: [string, string][] = [];
  raw.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (DROPPED.has(lower) || lower === TURN_HEADER.toLowerCase()) return;
    headers.push([name, value]);
  });
  const timezone = (raw as { cf?: { timezone?: unknown } }).cf?.timezone;
  return {
    url: raw.url,
    method: raw.method,
    headers,
    body,
    ...(typeof timezone === "string" ? { timezone } : {}),
  };
}

/**
 * Every turn this process is running, by the key on its replayed request.
 *
 * Module state, and it has to be: the route that reads it is reached through
 * `app.fetch` on a fresh request, and the key in its header is the only thing
 * that travels with it. On Cloudflare this is per isolate, and a turn and its
 * replay always share one — the Durable Object that runs the turn is also the
 * isolate the replay executes in.
 */
const byKey = new Map<string, DetachedTurn>();

/** The turn a request is the replay of, or undefined for an ordinary request. */
export function turnOfRequest(headerValue: string | undefined): DetachedTurn | undefined {
  return headerValue ? byKey.get(headerValue) : undefined;
}

export class DetachedTurn {
  readonly sessionId: string;
  readonly userId: string;
  readonly startedAt = Date.now();
  readonly timezone: string | undefined;
  /** Settles once the body has ended and every `waitUntil` it asked for has. */
  readonly finished: Promise<void>;

  private readonly key = crypto.randomUUID();
  private readonly controller = new AbortController();
  private readonly chunks: Uint8Array[] = [];
  private readonly listeners = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private head: Response | null = null;
  private readonly headReady: Promise<Response>;
  private resolveHead!: (res: Response) => void;
  private stopRequested = false;
  private ended = false;

  constructor(start: TurnStart, fetchApp: TurnFetch) {
    this.sessionId = start.sessionId;
    this.userId = start.userId;
    this.timezone = start.request.timezone;
    this.headReady = new Promise((resolve) => {
      this.resolveHead = resolve;
    });
    byKey.set(this.key, this);
    this.finished = this.run(start.request, fetchApp).finally(() => {
      byKey.delete(this.key);
      this.end();
    });
  }

  /** The signal the route passes to the model and to every tool. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Whether a person asked for this turn to stop, as opposed to it failing. */
  get stopped(): boolean {
    return this.stopRequested;
  }

  /** Whether the turn is still producing anything. */
  get running(): boolean {
    return !this.ended;
  }

  status(): TurnStatus {
    return { running: this.running, userId: this.userId, startedAt: this.startedAt };
  }

  /**
   * Ask the turn to stop, and wait for it to write down what it had.
   *
   * The abort reaches the route through `turnSignal`, which sends it down the
   * path a closed tab used to take — `salvagePartial` keeps the words already
   * written — and the wait is what lets the caller answer with that row rather
   * than with a promise that it will exist soon.
   */
  async stop(): Promise<void> {
    if (this.ended) return;
    this.stopRequested = true;
    this.controller.abort(new DOMException("Stopped by the person asking", "AbortError"));
    await Promise.race([
      this.finished,
      new Promise<void>((resolve) => setTimeout(resolve, STOP_WAIT_MS)),
    ]);
  }

  /**
   * The response to give the caller that started the turn.
   *
   * Anything but a stream is the route refusing — a 400, a 402, a 404 — and is
   * handed back as it is: there is no turn to outlive anybody. A stream is
   * answered with a subscription, so the caller sees what it always saw while
   * the turn itself belongs to this object.
   */
  async response(): Promise<Response> {
    const head = await this.headReady;
    if (!isEventStream(head)) return head;
    return new Response(this.subscribe(), {
      status: head.status,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  /**
   * Everything the turn has said so far, then everything it says from now on.
   *
   * From the first byte every time: the screen that reconnects has nothing of
   * this turn on it, and replaying the events rebuilds it — the text, the
   * steps, the card if it asked — through the same reader that drew it live.
   * Cancelling the stream unsubscribes; the turn does not notice.
   */
  subscribe(): ReadableStream<Uint8Array> {
    let mine: ReadableStreamDefaultController<Uint8Array> | null = null;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const chunk of this.chunks) controller.enqueue(chunk);
        if (this.ended) {
          controller.close();
          return;
        }
        mine = controller;
        this.listeners.add(controller);
      },
      cancel: () => {
        if (mine) this.listeners.delete(mine);
      },
    });
  }

  private async run(request: TurnRequest, fetchApp: TurnFetch): Promise<void> {
    const waits: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => {
        waits.push(promise);
      },
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;

    const headers = new Headers(request.headers);
    headers.set(TURN_HEADER, this.key);
    const replay = new Request(request.url, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      signal: this.controller.signal,
    });

    let res: Response;
    try {
      res = await fetchApp(replay, ctx);
    } catch (err) {
      console.error("a detached turn could not start", err);
      res = new Response(JSON.stringify({ error: "failed to start the reply" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    this.head = res;
    this.resolveHead(res);

    if (isEventStream(res) && res.body) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          this.publish(value);
        }
      } catch (err) {
        // The route closes its own stream on every ending it knows about, so
        // reaching this is the body itself failing. Logged, and the turn ends:
        // subscribers see the stream close without a final event, which the
        // screen already treats as a dropped connection.
        console.error("a detached turn's stream failed", err);
      }
    }

    // What the route deferred — the salvage of a stopped reply, its charge —
    // is part of the turn. Drained in a loop because one deferred job may
    // defer another.
    for (let seen = 0; seen < waits.length;) {
      const batch = waits.slice(seen);
      seen = waits.length;
      await Promise.allSettled(batch);
    }
  }

  private publish(chunk: Uint8Array) {
    this.chunks.push(chunk);
    for (const listener of this.listeners) {
      try {
        listener.enqueue(chunk);
      } catch {
        // A subscriber that went away between its cancel and this write.
        this.listeners.delete(listener);
      }
    }
  }

  private end() {
    if (this.ended) return;
    this.ended = true;
    // A turn whose route never answered at all still owes its caller a reply.
    if (!this.head) {
      this.resolveHead(
        new Response(JSON.stringify({ error: "failed to start the reply" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    for (const listener of this.listeners) {
      try {
        listener.close();
      } catch {
        // Already closed by its reader.
      }
    }
    this.listeners.clear();
  }
}

function isEventStream(res: Response): boolean {
  return (res.headers.get("Content-Type") ?? "").startsWith("text/event-stream");
}
