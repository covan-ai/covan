import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type Row } from "../../test-support/memory-db";
import type { IngestTrigger, RoutineRow } from "./executor";

const runPokedRoutine = vi.fn(
  async (..._args: unknown[]): Promise<{ status: string; itemsNew: number; summary?: string }> => ({
    status: "ok",
    itemsNew: 1,
  }),
);
let db: ReturnType<typeof memoryDb>["db"];

vi.mock("./dispatcher", () => ({
  runPokedRoutine: (...args: unknown[]) => runPokedRoutine(...args),
}));
vi.mock("../supabase", () => ({ serviceClient: () => db }));
const replyToTelegram = vi.fn(async (..._args: unknown[]) => {});
vi.mock("./events/telegram", () => ({
  replyToTelegram: (...args: unknown[]) => replyToTelegram(...args),
}));

const { RoutineRoom, startPokedRun } = await import("./poke-room");

const ROUTINE = { id: "r1", workspace_id: "w1", name: "Inbox" } as unknown as RoutineRow;
const TRIGGER: IngestTrigger = {
  eventId: "composio:gmail:m1",
  payload: "From: a@example.com",
  source: "event",
  label: "Gmail · New mail",
};

function routineRow(over: Row = {}): Row {
  return {
    id: "r1",
    workspace_id: "w1",
    name: "Inbox",
    status: "active",
    deleted_at: null,
    ...over,
  };
}

/** Just enough of a Durable Object's storage to drive the alarm by hand. */
function fakeState() {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    alarmAt: () => alarm,
    store,
    state: {
      storage: {
        put: async (k: string, v: unknown) => void store.set(k, v),
        get: async (k: string) => store.get(k),
        deleteAll: async () => {
          store.clear();
        },
        setAlarm: async (at: number) => {
          alarm = at;
        },
      },
    },
  };
}

/** A namespace whose one object answers with `answer`, recording what it was asked. */
function namespace(answer: () => Promise<Response>) {
  const calls: { name: string; url: string; body: unknown }[] = [];
  let name = "";
  return {
    calls,
    ns: {
      idFromName: (n: string) => {
        name = n;
        return n;
      },
      get: () => ({
        fetch: async (url: string, init: RequestInit) => {
          calls.push({ name, url, body: JSON.parse(String(init.body)) });
          return answer();
        },
      }),
    },
  };
}

function parkRequest(body: unknown, path = "/run") {
  return new Request(`https://routine-room${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  runPokedRoutine.mockReset().mockResolvedValue({ status: "ok", itemsNew: 1 });
  replyToTelegram.mockClear();
  db = memoryDb({ routines: [routineRow()] }).db;
});

describe("startPokedRun", () => {
  it("runs in place where no room is bound, as on Node", async () => {
    await startPokedRun({} as never, ROUTINE, TRIGGER);
    expect(runPokedRoutine).toHaveBeenCalledOnce();
    expect(runPokedRoutine.mock.calls[0].slice(1)).toEqual([ROUTINE, TRIGGER]);
  });

  it("parks the run in the event's own room and does not run it here", async () => {
    const room = namespace(async () => Response.json({ ok: true }, { status: 202 }));
    await startPokedRun({ ROUTINE_ROOMS: room.ns } as never, ROUTINE, TRIGGER);
    expect(runPokedRoutine).not.toHaveBeenCalled();
    expect(room.calls).toEqual([
      {
        name: "r1:composio:gmail:m1",
        url: "https://routine-room/run",
        body: { routineId: "r1", trigger: TRIGGER },
      },
    ]);
  });

  it("runs in place when the room refuses or cannot be reached", async () => {
    const refused = namespace(async () => new Response("no", { status: 500 }));
    await startPokedRun({ ROUTINE_ROOMS: refused.ns } as never, ROUTINE, TRIGGER);
    const down = namespace(async () => {
      throw new Error("network");
    });
    await startPokedRun({ ROUTINE_ROOMS: down.ns } as never, ROUTINE, TRIGGER);
    expect(runPokedRoutine).toHaveBeenCalledTimes(2);
  });
});

describe("RoutineRoom", () => {
  it("parks what it is given and sets an alarm for now", async () => {
    const s = fakeState();
    const room = new RoutineRoom(s.state as never, {} as never);
    const before = Date.now();
    const res = await room.fetch(parkRequest({ routineId: "r1", trigger: TRIGGER }));
    expect(res.status).toBe(202);
    expect(s.store.get("pending")).toEqual({ routineId: "r1", trigger: TRIGGER });
    expect(s.alarmAt()).toBeGreaterThanOrEqual(before);
    expect(runPokedRoutine).not.toHaveBeenCalled();
  });

  it("refuses a body without a routine and an event id, and any other path", async () => {
    const s = fakeState();
    const room = new RoutineRoom(s.state as never, {} as never);
    expect((await room.fetch(parkRequest({ routineId: "r1" }))).status).toBe(400);
    expect((await room.fetch(parkRequest({ trigger: TRIGGER }))).status).toBe(400);
    expect((await room.fetch(parkRequest({}, "/other"))).status).toBe(404);
    expect(s.alarmAt()).toBeNull();
  });

  it("runs the routine read fresh, and forgets the run before starting it", async () => {
    const s = fakeState();
    const room = new RoutineRoom(s.state as never, {} as never);
    await room.fetch(parkRequest({ routineId: "r1", trigger: TRIGGER }));
    runPokedRoutine.mockImplementationOnce(async () => {
      // A retry of a throwing alarm must find nothing to run twice.
      expect(s.store.size).toBe(0);
      return { status: "ok", itemsNew: 1 };
    });
    await room.alarm();
    expect(runPokedRoutine).toHaveBeenCalledOnce();
    const [, routine, trigger] = runPokedRoutine.mock.calls[0] as [unknown, Row, IngestTrigger];
    expect(routine).toMatchObject({ id: "r1", status: "active" });
    expect(trigger).toEqual(TRIGGER);
  });

  it("does not run a routine paused or deleted since it was poked", async () => {
    for (const over of [{ status: "paused" }, { deleted_at: "2026-10-16T00:00:00Z" }]) {
      db = memoryDb({ routines: [routineRow(over)] }).db;
      const s = fakeState();
      const room = new RoutineRoom(s.state as never, {} as never);
      await room.fetch(parkRequest({ routineId: "r1", trigger: TRIGGER }));
      await room.alarm();
      expect(s.store.size).toBe(0);
    }
    expect(runPokedRoutine).not.toHaveBeenCalled();
  });

  it("does nothing on an alarm with nothing parked, and swallows a failed run", async () => {
    const s = fakeState();
    const room = new RoutineRoom(s.state as never, {} as never);
    await room.alarm();
    expect(runPokedRoutine).not.toHaveBeenCalled();

    await room.fetch(parkRequest({ routineId: "r1", trigger: TRIGGER }));
    runPokedRoutine.mockRejectedValueOnce(new Error("model down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(room.alarm()).resolves.toBeUndefined();
    error.mockRestore();
  });
});

describe("answering where the event came from", () => {
  const FROM_CHAT: IngestTrigger = {
    ...TRIGGER,
    replyTo: { provider: "telegram", chatId: "42", messageId: 7 },
  };

  it("answers the Telegram chat after the run, in place", async () => {
    runPokedRoutine.mockResolvedValueOnce({ status: "ok", itemsNew: 1, summary: "Sales up 4%." });
    await startPokedRun({} as never, ROUTINE, FROM_CHAT);
    expect(replyToTelegram.mock.calls[0].slice(1)).toEqual([
      "r1",
      FROM_CHAT.replyTo,
      { status: "ok", itemsNew: 1, summary: "Sales up 4%." },
    ]);
  });

  it("answers from the room's alarm too, and nothing for an event with nowhere to answer", async () => {
    const s = fakeState();
    const room = new RoutineRoom(s.state as never, {} as never);
    await room.fetch(parkRequest({ routineId: "r1", trigger: FROM_CHAT }));
    await room.alarm();
    expect(replyToTelegram).toHaveBeenCalledOnce();

    await startPokedRun({} as never, ROUTINE, TRIGGER);
    expect(replyToTelegram).toHaveBeenCalledOnce();
  });
});

describe("waiting for the result", () => {
  it("hands back the result when the run finishes in time, in place", async () => {
    runPokedRoutine.mockResolvedValueOnce({ status: "ok", itemsNew: 1, summary: "Done." });
    const keepAlive = vi.fn();
    const result = await startPokedRun({} as never, ROUTINE, TRIGGER, { waitMs: 1_000, keepAlive });
    expect(result).toEqual({ status: "ok", itemsNew: 1, summary: "Done." });
    expect(keepAlive).toHaveBeenCalledOnce();
  });

  it("answers null when it does not, and leaves the run going", async () => {
    let finish!: (r: unknown) => void;
    runPokedRoutine.mockImplementationOnce(() => new Promise((r) => (finish = r)) as never);
    const keepAlive = vi.fn();
    const result = await startPokedRun({} as never, ROUTINE, TRIGGER, { waitMs: 10, keepAlive });
    expect(result).toBeNull();
    const kept = keepAlive.mock.calls[0][0] as Promise<unknown>;
    finish({ status: "ok", itemsNew: 1 });
    await expect(kept).resolves.toMatchObject({ status: "ok" });
  });

  it("asks the room to wait, and reads its answer", async () => {
    const room = namespace(async () =>
      Response.json({ ok: true, result: { status: "ok", itemsNew: 1, summary: "From the room." } }),
    );
    const result = await startPokedRun({ ROUTINE_ROOMS: room.ns } as never, ROUTINE, TRIGGER, {
      waitMs: 60_000,
    });
    expect(result).toMatchObject({ summary: "From the room." });
    // Capped, whatever was asked for.
    expect(room.calls[0].url).toBe("https://routine-room/run?wait=25000");
    expect(runPokedRoutine).not.toHaveBeenCalled();
  });

  it("holds a waiting caller in the room until its alarm has run", async () => {
    runPokedRoutine.mockResolvedValueOnce({
      status: "ok",
      itemsNew: 1,
      summary: "Alarm's report.",
    });
    const s = fakeState();
    const room = new RoutineRoom(s.state as never, {} as never);
    const answer = room.fetch(parkRequest({ routineId: "r1", trigger: TRIGGER }, "/run?wait=5000"));
    await new Promise((r) => setTimeout(r, 0));
    await room.alarm();
    const body = (await (await answer).json()) as { result: { summary: string } };
    expect(body.result.summary).toBe("Alarm's report.");
  });

  it("lets a waiting caller go with null when the alarm takes too long", async () => {
    const s = fakeState();
    const room = new RoutineRoom(s.state as never, {} as never);
    const res = await room.fetch(parkRequest({ routineId: "r1", trigger: TRIGGER }, "/run?wait=5"));
    expect(await res.json()).toEqual({ ok: true, result: null });
  });
});
