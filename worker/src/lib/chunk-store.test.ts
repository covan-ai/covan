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

    expect(insert).toHaveBeenCalledTimes(3); // 200 + 200 + 50
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

    expect(insert).toHaveBeenCalledTimes(2); // third batch never attempted
    expect(res.error).toEqual({ message: "boom" });
  });

  it("does nothing for an empty row set", async () => {
    const insert = vi.fn();
    const res = await insertChunkRows(fakeDb(insert), []);

    expect(insert).not.toHaveBeenCalled();
    expect(res.error).toBeNull();
  });
});
