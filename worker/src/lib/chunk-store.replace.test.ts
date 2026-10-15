import { describe, expect, it } from "vitest";
import { fakeDb, type QueryContext } from "../test-support/fake-db";
import { CHUNK_INSERT_BATCH, replaceChunks } from "./chunk-store";

const row = (i: number) => ({
  document_id: "d1",
  bundle_id: "b1",
  workspace_id: "w1",
  chunk_index: i,
  content: `chunk ${i}`,
  context: "doc.md",
  embedding: [i],
});

/** A document whose newest passages are generation `newest`, failing the nth insert. */
function db(newest: number | null, failInsertNumber?: number) {
  let inserts = 0;
  return fakeDb({
    tables: {
      document_chunks: {
        select: () => ({
          data: newest === null ? [] : [{ generation: newest }],
          error: null,
        }),
        insert: () => {
          inserts++;
          return inserts === failInsertNumber
            ? { data: null, error: { message: "statement timeout" } }
            : { data: null, error: null };
        },
        delete: () => ({ data: null, error: null }),
      },
    },
  });
}

const deletes = (fake: ReturnType<typeof db>) =>
  fake.callsTo("document_chunks").filter((c: QueryContext) => c.op === "delete");

describe("replaceChunks", () => {
  it("writes the new passages a generation up, then clears the older ones", async () => {
    const fake = db(2);

    const res = await replaceChunks(fake.db as never, "d1", [row(0), row(1)]);

    expect(res).toEqual({ error: null, count: 2 });
    const inserted = fake.callsTo("document_chunks").find((c) => c.op === "insert");
    expect(
      (inserted?.values as unknown as Array<{ generation: number }>).map((r) => r.generation),
    ).toEqual([3, 3]);
    const [clear] = deletes(fake);
    expect(clear.filters).toContainEqual({ column: "document_id", value: "d1", kind: "eq" });
    expect(clear.filters).toContainEqual({ column: "generation", value: 3, kind: "lt" });
  });

  it("starts a document with no passages at generation 0", async () => {
    const fake = db(null);

    await replaceChunks(fake.db as never, "d1", [row(0)]);

    const inserted = fake.callsTo("document_chunks").find((c) => c.op === "insert");
    expect((inserted?.values as unknown as Array<{ generation: number }>)[0].generation).toBe(0);
  });

  // The case this exists for: a failure part-way through used to leave a third
  // of a document searchable and the document reading as indexed.
  it("removes a partial set and leaves the old passages alone when a batch fails", async () => {
    const fake = db(0, 2);
    const rows = Array.from({ length: CHUNK_INSERT_BATCH + 5 }, (_, i) => row(i));

    const res = await replaceChunks(fake.db as never, "d1", rows);

    expect(res.count).toBe(0);
    expect(res.error).toBeTruthy();
    const all = deletes(fake);
    expect(all).toHaveLength(1);
    expect(all[0].filters).toContainEqual({ column: "generation", value: 1, kind: "eq" });
  });
});
