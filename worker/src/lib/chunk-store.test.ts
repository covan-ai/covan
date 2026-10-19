import { describe, expect, it, vi } from "vitest";
import { insertChunkRows, CHUNK_INSERT_BATCH } from "./chunk-store";

function fakeDb(insert: ReturnType<typeof vi.fn>) {
  return { from: () => ({ insert }) } as never;
}

const row = (i: number) => ({
  document_id: "d1",
  bundle_id: "b1",
  workspace_id: "w1",
  chunk_index: i,
  content: `chunk ${i}`,
  context: "doc.md",
  embedding: [i],
});

describe("insertChunkRows", () => {
  it("sends one request when the rows fit in a single batch", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const res = await insertChunkRows(fakeDb(insert), [row(0), row(1)]);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0]).toHaveLength(2);
    expect(res.error).toBeNull();
  });

  it("splits large row sets and never exceeds the batch size", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const rows = Array.from({ length: 450 }, (_, i) => row(i));

    const res = await insertChunkRows(fakeDb(insert), rows);

    expect(insert).toHaveBeenCalledTimes(Math.ceil(450 / CHUNK_INSERT_BATCH));
    for (const call of insert.mock.calls) {
      expect(call[0].length).toBeLessThanOrEqual(CHUNK_INSERT_BATCH);
    }
    // Every row went exactly once, in order.
    const sent = insert.mock.calls.flatMap((c) => c[0] as ReturnType<typeof row>[]);
    expect(sent.map((r) => r.chunk_index)).toEqual(rows.map((r) => r.chunk_index));
    expect(res.error).toBeNull();
  });

  it("stops at the first failing batch and returns its error", async () => {
    const insert = vi
      .fn()
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: "boom" } });
    const rows = Array.from({ length: 450 }, (_, i) => row(i));

    const res = await insertChunkRows(fakeDb(insert), rows);

    expect(insert).toHaveBeenCalledTimes(2); // no batch after the failing one is attempted
    expect(res.error).toEqual({ message: "boom" });
  });

  it("does nothing for an empty row set", async () => {
    const insert = vi.fn();
    const res = await insertChunkRows(fakeDb(insert), []);

    expect(insert).not.toHaveBeenCalled();
    expect(res.error).toBeNull();
  });
});

describe("insertChunkRows with a passage index (0116)", () => {
  function besideDb(insertResult: { data: unknown; error: unknown }) {
    const sent: unknown[][] = [];
    const deleted: string[][] = [];
    const db = {
      from: () => ({
        insert: (rows: unknown[]) => {
          sent.push(rows);
          return { select: () => Promise.resolve(insertResult) };
        },
        delete: () => ({
          in: (_col: string, ids: string[]) => {
            deleted.push(ids);
            return Promise.resolve({ error: null });
          },
        }),
      }),
    } as never;
    return { db, sent, deleted };
  }

  it("writes the rows without their embeddings and the vectors under the rows' ids", async () => {
    const { db, sent } = besideDb({
      data: [
        { id: "c1", document_id: "d1", chunk_index: 1 },
        { id: "c0", document_id: "d1", chunk_index: 0 },
      ],
      error: null,
    });
    const upsert = vi.fn().mockResolvedValue({ mutationId: "m" });

    const res = await insertChunkRows(db, [row(0), row(1)], { upsert } as never);

    expect(res.error).toBeNull();
    expect(sent[0]).toHaveLength(2);
    expect(sent[0].every((r) => !("embedding" in (r as object)))).toBe(true);
    // Matched by document and position, not by the order the ids came back in.
    expect(upsert).toHaveBeenCalledWith([
      {
        id: "c0",
        values: [0],
        metadata: { bundle_id: "b1", document_id: "d1", workspace_id: "w1" },
      },
      {
        id: "c1",
        values: [1],
        metadata: { bundle_id: "b1", document_id: "d1", workspace_id: "w1" },
      },
    ]);
  });

  it("takes the rows back out when the index refuses the vectors", async () => {
    const { db, deleted } = besideDb({
      data: [{ id: "c0", document_id: "d1", chunk_index: 0 }],
      error: null,
    });
    const upsert = vi.fn().mockRejectedValue(new Error("index down"));

    const res = await insertChunkRows(db, [row(0)], { upsert } as never);

    expect(res.error).toBe("index down");
    expect(deleted).toEqual([["c0"]]);
  });

  it("reports a failed insert without touching the index", async () => {
    const { db } = besideDb({ data: null, error: { message: "boom" } });
    const upsert = vi.fn();

    const res = await insertChunkRows(db, [row(0)], { upsert } as never);

    expect(res.error).toEqual({ message: "boom" });
    expect(upsert).not.toHaveBeenCalled();
  });
});
