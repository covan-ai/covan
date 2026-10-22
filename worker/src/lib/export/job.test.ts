import { describe, expect, it, vi } from "vitest";
import type { DocStore } from "../docstore";
import { exportObjectKey, prepareExport, uploadInParts, type ExportJobDeps } from "./job";

vi.mock("./collect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./collect")>()),
  collectWorkspace: vi.fn(async () => ({})),
}));

function memoryStore() {
  const parts: Array<{ part: number; size: number }> = [];
  const completed: string[] = [];
  const aborted: string[] = [];
  const store = {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    getRange: async () => null,
    createMultipart: async () => "upload-1",
    uploadPart: async (_k: string, _u: string, part: number, body: ArrayBuffer) => {
      parts.push({ part, size: body.byteLength });
      return { partNumber: part, etag: `e${part}` };
    },
    completeMultipart: async (key: string) => {
      completed.push(key);
    },
    abortMultipart: async (key: string) => {
      aborted.push(key);
    },
  } as unknown as DocStore;
  return { store, parts, completed, aborted };
}

function streamOf(chunks: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const n of chunks) controller.enqueue(new Uint8Array(n));
      controller.close();
    },
  });
}

describe("uploading in parts", () => {
  it("cuts equal parts and a shorter last one, and counts the bytes", async () => {
    const { store, parts, completed } = memoryStore();
    const size = await uploadInParts(streamOf([7, 7, 7]), store, "k", "u", 10);
    expect(size).toBe(21);
    expect(parts).toEqual([
      { part: 1, size: 10 },
      { part: 2, size: 10 },
      { part: 3, size: 1 },
    ]);
    expect(completed).toEqual(["k"]);
  });

  it("writes one empty part for an empty archive", async () => {
    const { store, parts } = memoryStore();
    expect(await uploadInParts(streamOf([]), store, "k", "u", 10)).toBe(0);
    expect(parts).toEqual([{ part: 1, size: 0 }]);
  });
});

function deps(over: { role?: string; user?: { id: string; email: string } | null } = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const mails: unknown[] = [];
  const asRequester = vi.fn(async () => {
    const chain = (data: unknown) => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.maybeSingle = async () => ({ data, error: null });
      return c;
    };
    return {
      from: (table: string) =>
        table === "workspace_members"
          ? chain(over.role === undefined ? { role: "admin" } : { role: over.role })
          : chain({ id: "w1", name: "Acme" }),
    } as never;
  });
  const { store, completed, aborted } = memoryStore();
  const d: ExportJobDeps = {
    db: {
      auth: {
        admin: {
          getUserById: async () => ({
            data: {
              user: over.user === undefined ? { id: "u1", email: "ada@acme.test" } : over.user,
            },
          }),
        },
      },
      from: () => ({
        update: (values: Record<string, unknown>) => ({
          eq: async () => {
            updates.push(values);
            return { error: null };
          },
        }),
      }),
    } as never,
    store,
    asRequester,
    mail: async (email) => {
      mails.push(email);
    },
    appUrl: "https://app.covan.test",
    now: () => new Date("2026-10-22T10:00:00Z"),
  };
  return { d, updates, mails, asRequester, completed, aborted };
}

describe("preparing an export", () => {
  const row = { id: "x1", workspace_id: "w1", requested_by: "u1" };

  it("reads as the requester, stores the zip, keeps it a week and mails the link", async () => {
    const { d, updates, mails, asRequester, completed } = deps();
    expect(await prepareExport(row, d)).toBe(true);
    expect(asRequester).toHaveBeenCalledWith({ id: "u1", email: "ada@acme.test" }, "w1");
    expect(completed).toEqual([exportObjectKey("w1", "x1")]);
    expect(updates[0]).toMatchObject({
      status: "ready",
      object_key: "exports/w1/x1.zip",
      expires_at: "2026-10-29T10:00:00.000Z",
    });
    expect((updates[0]!.size_bytes as number) > 0).toBe(true);
    expect(mails).toHaveLength(1);
    expect(JSON.stringify(mails[0])).toContain("/settings/export?download=x1");
  });

  it("says why it stopped when the requester is no longer an admin, or gone", async () => {
    const demoted = deps({ role: "member" });
    expect(await prepareExport(row, demoted.d)).toBe(false);
    expect(demoted.updates[0]).toMatchObject({
      status: "failed",
      error: "whoever asked is no longer an admin here",
    });
    expect(demoted.completed).toEqual([]);

    const gone = deps({ user: null });
    await prepareExport(row, gone.d);
    expect(gone.updates[0]).toMatchObject({
      status: "failed",
      error: "the person who asked for it has left",
    });
  });
});
