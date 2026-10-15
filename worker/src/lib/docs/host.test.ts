import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentRoom, advanceDueDocumentJobs, documentHost } from "./host";

const advanceDocumentJob = vi.fn();
const rpc = vi.fn();
const update = vi.fn();

vi.mock("./engine", () => ({
  advanceDocumentJob: (...args: unknown[]) => advanceDocumentJob(...args),
}));
vi.mock("../supabase", () => ({
  serviceClient: () => ({
    rpc: (...args: unknown[]) => rpc(...args),
    from: () => ({
      update: (values: unknown) => {
        update(values);
        return { eq: () => Promise.resolve({ data: null, error: null }) };
      },
    }),
  }),
}));

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
          alarm = null;
        },
        getAlarm: async () => alarm,
        setAlarm: async (at: number) => {
          alarm = at;
        },
      },
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("documentHost", () => {
  it("is the Durable Object where one is bound, the process on Node, and nothing otherwise", () => {
    expect(documentHost({ DOC_ROOMS: {} } as never)).not.toBeNull();
    expect(documentHost({ PEER_ADDR: "" } as never)).not.toBeNull();
    expect(documentHost({} as never)).toBeNull();
  });
});

describe("DocumentRoom", () => {
  it("sets an alarm for now when kicked, and not over a backoff already set", async () => {
    const s = fakeState();
    const room = new DocumentRoom(s.state as never, {} as never);

    await room.fetch(new Request("https://document-room/kick?job=job-1", { method: "POST" }));
    expect(s.store.get("job")).toBe("job-1");
    const first = s.alarmAt();
    expect(first).not.toBeNull();

    await s.state.storage.setAlarm(9_999_999_999_999);
    await room.fetch(new Request("https://document-room/kick?job=job-1", { method: "POST" }));
    expect(s.alarmAt()).toBe(9_999_999_999_999);
  });

  it("runs one unit per alarm and sets the next from the engine's answer", async () => {
    const s = fakeState();
    s.store.set("job", "job-1");
    const room = new DocumentRoom(s.state as never, {} as never);

    advanceDocumentJob.mockResolvedValueOnce({ next: "at", at: 123_456 });
    await room.alarm();
    expect(advanceDocumentJob).toHaveBeenCalledTimes(1);
    expect(s.alarmAt()).toBe(123_456);

    advanceDocumentJob.mockResolvedValueOnce({ next: "none" });
    await room.alarm();
    expect(s.store.size).toBe(0);
  });

  it("keeps going after a unit that threw, rather than letting Cloudflare retry it blind", async () => {
    const s = fakeState();
    s.store.set("job", "job-1");
    const room = new DocumentRoom(s.state as never, {} as never);
    advanceDocumentJob.mockRejectedValueOnce(new Error("boom"));

    await expect(room.alarm()).resolves.toBeUndefined();
    expect(s.alarmAt()).toBeGreaterThan(Date.now());
  });
});

describe("advanceDueDocumentJobs", () => {
  it("costs one claim when nothing is due", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    expect(await advanceDueDocumentJobs({} as never)).toBe(false);
    expect(advanceDocumentJob).not.toHaveBeenCalled();
  });

  it("advances each job it claimed by one unit", async () => {
    rpc.mockResolvedValue({ data: [{ id: "a" }, { id: "b" }], error: null });
    advanceDocumentJob.mockResolvedValue({ next: "now" });

    expect(await advanceDueDocumentJobs({} as never)).toBe(true);
    expect(advanceDocumentJob.mock.calls.map((c) => c[2])).toEqual(["a", "b"]);
  });
});
