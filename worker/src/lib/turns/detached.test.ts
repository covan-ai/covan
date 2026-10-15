import { afterEach, describe, expect, it } from "vitest";
import { TURN_HEADER, captureRequest, turnOfRequest, type TurnFetch } from "./detached";
import { localTurn, resetLocalTurns, startLocalTurn } from "./local";

/**
 * A route that streams the way `/chat/stream` does: one SSE frame per word,
 * until its signal is aborted — at which point it defers a salvage, as the real
 * abort path does, and closes.
 */
function fakeTurn(words: string[], opts: { gapMs?: number; salvaged?: string[] } = {}): TurnFetch {
  return async (request, ctx) => {
    const signal = turnOfRequest(request.headers.get(TURN_HEADER) ?? undefined)?.signal;
    const encoder = new TextEncoder();
    let written = "";
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const word of words) {
          if (signal?.aborted) break;
          await new Promise((r) => setTimeout(r, opts.gapMs ?? 1));
          if (signal?.aborted) break;
          written += word;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "delta", text: word })}\n\n`),
          );
        }
        if (signal?.aborted) {
          ctx.waitUntil(
            new Promise<void>((resolve) =>
              setTimeout(() => {
                opts.salvaged?.push(written);
                resolve();
              }, 5),
            ),
          );
        } else {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
        }
        controller.close();
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  };
}

const start = (sessionId = "s1") => ({
  sessionId,
  userId: "u1",
  request: {
    url: "https://api.example/chat/stream",
    method: "POST",
    headers: [["Content-Type", "application/json"]] as [string, string][],
    body: JSON.stringify({ sessionId }),
  },
});

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

afterEach(() => resetLocalTurns());

describe("a detached turn", () => {
  it("runs to the end after the browser that started it has gone", async () => {
    const started = startLocalTurn(start(), fakeTurn(["a", "b", "c"], { gapMs: 5 }));
    if (started.kind !== "started") throw new Error("expected a turn");

    const res = await started.turn.response();
    const reader = res.body!.getReader();
    await reader.read();
    // The tab closes after the first word.
    await reader.cancel();

    await started.turn.finished;
    const replay = await readAll(localTurn("s1")!.subscribe());
    expect(replay).toContain('"text":"c"');
    expect(replay).toContain('"type":"done"');
  });

  it("shows a browser that comes back the whole turn from its first event", async () => {
    const started = startLocalTurn(start(), fakeTurn(["one ", "two"], { gapMs: 10 }));
    if (started.kind !== "started") throw new Error("expected a turn");
    await new Promise((r) => setTimeout(r, 15));

    const late = await readAll(localTurn("s1")!.subscribe());
    expect(late.indexOf('"one "')).toBeLessThan(late.indexOf('"two"'));
    expect(late).toContain('"type":"done"');
  });

  it("stops when asked, and waits for what it deferred to be written", async () => {
    const salvaged: string[] = [];
    const started = startLocalTurn(
      start(),
      fakeTurn(["a", "b", "c", "d"], { gapMs: 10, salvaged }),
    );
    if (started.kind !== "started") throw new Error("expected a turn");
    await new Promise((r) => setTimeout(r, 15));

    await started.turn.stop();
    expect(started.turn.stopped).toBe(true);
    expect(started.turn.running).toBe(false);
    // The salvage ran before `stop` returned, which is what lets the route
    // answer with the row.
    expect(salvaged).toHaveLength(1);
    expect(salvaged[0].length).toBeGreaterThan(0);
    expect(salvaged[0]).not.toBe("abcd");
  });

  it("refuses a second turn in the same conversation while one is running", async () => {
    startLocalTurn(start(), fakeTurn(["a"], { gapMs: 20 }));
    expect(startLocalTurn(start(), fakeTurn(["b"])).kind).toBe("busy");
    expect(startLocalTurn(start("s2"), fakeTurn(["b"])).kind).toBe("started");
  });

  it("hands a refusal back as it is, with no turn to outlive anybody", async () => {
    const refusing: TurnFetch = async () => Response.json({ error: "no credits" }, { status: 402 });
    const started = startLocalTurn(start(), refusing);
    if (started.kind !== "started") throw new Error("expected a turn");
    const res = await started.turn.response();
    expect(res.status).toBe(402);
    await started.turn.finished;
    expect(started.turn.running).toBe(false);
  });

  it("marks only the request it replays, never one a caller labelled itself", async () => {
    const raw = new Request("https://api.example/chat/stream", {
      method: "POST",
      headers: { [TURN_HEADER]: "forged", Authorization: "Bearer t" },
      body: "{}",
    });
    const captured = await captureRequest(raw, "{}");
    expect(captured.headers.map(([name]) => name.toLowerCase())).not.toContain(
      TURN_HEADER.toLowerCase(),
    );
    expect(turnOfRequest("forged")).toBeUndefined();
  });
});
