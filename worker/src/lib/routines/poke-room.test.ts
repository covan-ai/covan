import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type Row } from "../../test-support/memory-db";
import type { IngestTrigger, RoutineRow } from "./executor";

const runPokedRoutine = vi.fn(async (..._args: unknown[]) => ({ status: "ok", itemsNew: 1 }));
let db: ReturnType<typeof memoryDb>["db"];

vi.mock("./dispatcher", () => ({
  runPokedRoutine: (...args: unknown[]) => runPokedRoutine(...args),
}));
vi.mock("../supabase", () => ({ serviceClient: () => db }));

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
  runPokedRoutine.mockClear();
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
