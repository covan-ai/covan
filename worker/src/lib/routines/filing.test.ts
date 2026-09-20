import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fileRoutineOutput,
  filedDocumentName,
  filedDocumentText,
  FILING_CHUNK_SIZE,
  MAX_PRUNE_PER_RUN,
  NOTE_BUNDLE_GONE,
  NOTE_EMPTY,
  type FilingInput,
} from "./filing";

// The store is an interface for exactly this reason — one of two
// implementations on two runtimes — so the test drives the interface rather
// than a filesystem.
const store = {
  put: vi.fn(async (_key: string, _bytes: ArrayBuffer, _opts?: unknown) => {}),
  delete: vi.fn(async (_key: string) => {}),
  get: vi.fn(),
};
vi.mock("../docstore", () => ({ getDocStore: () => store }));

// `chunkText` is pure and stays real: the geometry it produces is part of what
// this module decides. `embedTexts` is a paid network call.
const { embedTexts } = vi.hoisted(() => ({
  embedTexts: vi.fn(async (_env: unknown, chunks: string[]) => ({
    vectors: chunks.map(() => [0.1, 0.2]),
    tokens: 40 * chunks.length,
  })),
}));
vi.mock("../embeddings", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  embedTexts,
}));

const AT = new Date("2026-09-20T09:00:00.000Z");

const input = (over: Partial<FilingInput> = {}): FilingInput => ({
  routineId: "r1",
  routineName: "Competitor digest",
  workspaceId: "w1",
  bundleId: "b1",
  retention: 52,
  summary: "They shipped a pricing page and dropped the free tier.",
  at: AT,
  ...over,
});

type Recorded = {
  inserts: Array<{ table: string; values: any }>;
  updates: Array<{ table: string; values: any; ids: string[] }>;
  ranges: Array<{ from: number; to: number }>;
};

function makeDb(
  over: {
    /** null means the bundle is not in this workspace, or is gone. */
    bundle?: { id: string } | null;
    /** What the retention read returns — the documents past the cutoff. */
    surplus?: Array<{ id: string }>;
    documentInsertError?: { message: string };
    chunkInsertError?: { message: string };
    pruneError?: { message: string };
  } = {},
) {
  const rec: Recorded = { inserts: [], updates: [], ranges: [] };
  const bundle = over.bundle === undefined ? { id: "b1" } : over.bundle;

  const db: any = {
    from: (table: string) => ({
      select: () => {
        const chain: any = {
          eq: () => chain,
          is: () => chain,
          order: () => chain,
          range: async (from: number, to: number) => {
            rec.ranges.push({ from, to });
            if (over.pruneError) return { data: null, error: over.pruneError };
            return { data: over.surplus ?? [], error: null };
          },
          maybeSingle: async () => ({ data: table === "knowledge_bundles" ? bundle : null }),
        };
        return chain;
      },
      insert: (values: any) => {
        rec.inserts.push({ table, values });
        if (table === "document_chunks") return { error: over.chunkInsertError ?? null };
        return {
          select: () => ({
            single: async () =>
              over.documentInsertError
                ? { data: null, error: over.documentInsertError }
                : { data: { id: "d-new" }, error: null },
          }),
        };
      },
      update: (values: any) => ({
        in: async (_col: string, ids: string[]) => {
          rec.updates.push({ table, values, ids });
          return { error: null };
        },
      }),
    }),
  };

  return { db, rec };
}

beforeEach(() => {
  store.put.mockClear();
  store.delete.mockClear();
  embedTexts.mockClear();
});

describe("what a filed summary looks like", () => {
  it("names the document after the routine and the day", () => {
    expect(filedDocumentName("Competitor digest", AT)).toBe("Competitor digest — 2026-09-20.md");
  });

  it("does not sanitise the name a person reads", () => {
    // `safeName` is for the object key. Turning "Aylık Rapor" into
    // "Ayl_k_Rapor" on screen for the sake of a key nobody sees is the mistake
    // the upload and report routes already avoid.
    expect(filedDocumentName("Aylık Rapor", AT)).toBe("Aylık Rapor — 2026-09-20.md");
  });

  it("heads the text, so a retrieved passage is dated evidence", () => {
    const text = filedDocumentText("Competitor digest", AT, "They shipped a pricing page.");
    // A chunk that arrives in a chat turn with nothing around it has to say
    // what it is and when it was true.
    expect(text.startsWith("# Competitor digest — 2026-09-20\n")).toBe(true);
    expect(text).toContain("They shipped a pricing page.");
  });
});

describe("fileRoutineOutput", () => {
  it("writes the document, indexes it, and reports what it cost", async () => {
    const { db, rec } = makeDb();

    const result = await fileRoutineOutput(db, {} as any, input());

    expect(result).toEqual({ filed: true, documentId: "d-new", indexTokens: 40 });

    const doc = rec.inserts.find((i) => i.table === "documents")!;
    expect(doc.values.bundle_id).toBe("b1");
    // The provenance column, which is also the structural half of the loop
    // guard in `connection-source.ts`.
    expect(doc.values.routine_id).toBe("r1");
    expect(doc.values.name).toBe("Competitor digest — 2026-09-20.md");
    expect(doc.values.content).toContain("dropped the free tier");
    expect(store.put).toHaveBeenCalledTimes(1);
    // The key is sanitised even though the name is not, and it is scoped to the
    // bundle like every other object in the store.
    expect(store.put.mock.calls[0][0]).toMatch(/^b1\//);

    const chunks = rec.inserts.find((i) => i.table === "document_chunks")!;
    expect(chunks.values[0].workspace_id).toBe("w1");
    expect(chunks.values[0].context).toBe("Competitor digest — 2026-09-20.md");
  });

  it("refuses a bundle that is not in the routine's workspace", async () => {
    // The service role bypasses RLS, so the scoping in this module is the only
    // thing standing between a tampered `output_bundle_id` and a document
    // written into somebody else's knowledge base. 0056's policies are the
    // other half of the same guard; this is what holds for rows written before
    // them.
    const { db, rec } = makeDb({ bundle: null });

    const result = await fileRoutineOutput(db, {} as any, input());

    expect(result).toEqual({ filed: false, note: NOTE_BUNDLE_GONE });
    expect(rec.inserts).toEqual([]);
    expect(store.put).not.toHaveBeenCalled();
  });

  it("files nothing for a summary with nothing in it", async () => {
    const { db } = makeDb();

    const result = await fileRoutineOutput(db, {} as any, input({ summary: "   \n  " }));

    // A whitespace summary would upload fine, be listed, be named to the model
    // on every turn and retrieve nothing. The same gate the upload form applies.
    expect(result).toEqual({ filed: false, note: NOTE_EMPTY });
  });

  it("puts the stored object back when the row will not insert", async () => {
    const { db } = makeDb({ documentInsertError: { message: "column gone" } });

    const result = await fileRoutineOutput(db, {} as any, input());

    expect(result).toEqual({ filed: false, note: "not filed: column gone" });
    // Otherwise every failed filing leaves an orphan in R2 that nothing will
    // ever look at or delete.
    expect(store.delete).toHaveBeenCalledTimes(1);
    expect(store.delete.mock.calls[0][0]).toBe(store.put.mock.calls[0][0]);
  });

  it("keeps the document when only the embedding fails", async () => {
    embedTexts.mockRejectedValueOnce(new Error("embeddings down"));
    const { db, rec } = makeDb();

    const result = await fileRoutineOutput(db, {} as any, input());

    // The same bargain the upload route makes. It reads "Not indexed" in the
    // Knowledge tab and the reindex control beside it is the way back; losing
    // what was just written would be the worse answer.
    expect(result).toEqual({ filed: true, documentId: "d-new", indexTokens: 0 });
    expect(rec.inserts.some((i) => i.table === "document_chunks")).toBe(false);
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("never throws, whatever the database does", async () => {
    const db: any = {
      from: () => {
        throw new Error("connection reset");
      },
    };

    // The contract, and the reason for it: this runs after the message has
    // gone out, so an exception would be caught by `runRoutine`, counted as a
    // failure and would eventually pause a routine that is working.
    const result = await fileRoutineOutput(db, {} as any, input());
    expect(result).toEqual({ filed: false, note: "not filed: connection reset" });
  });

  it("chunks a long summary with the geometry a written document wants", async () => {
    const { db, rec } = makeDb();
    const long = "Sentence about the release. ".repeat(400);

    await fileRoutineOutput(db, {} as any, input({ summary: long }));

    const chunks = rec.inserts.find((i) => i.table === "document_chunks")!.values;
    expect(chunks.length).toBeGreaterThan(1);
    for (const row of chunks) expect(row.content.length).toBeLessThanOrEqual(FILING_CHUNK_SIZE);
    // Indexed in order, which is what makes a retrieved passage's neighbours
    // findable.
    expect(chunks.map((r: any) => r.chunk_index)).toEqual(chunks.map((_: any, i: number) => i));
  });
});

describe("retention", () => {
  it("asks only for what is past the cutoff", async () => {
    const { db, rec } = makeDb({ surplus: [] });

    await fileRoutineOutput(db, {} as any, input({ retention: 52 }));

    // Offset by the retention: rows 0..51 are the ones being kept, so the read
    // starts at 52. Bounded, because a prune only ever goes over by one per
    // run — the only time it is large is the first run after somebody lowers
    // the number, and that should take several runs rather than one statement
    // that may not finish inside a Worker's budget.
    expect(rec.ranges).toEqual([{ from: 52, to: 52 + MAX_PRUNE_PER_RUN - 1 }]);
  });

  it("hides what aged out without pretending somebody deleted it", async () => {
    const { db, rec } = makeDb({ surplus: [{ id: "old1" }, { id: "old2" }] });

    await fileRoutineOutput(db, {} as any, input({ retention: 4 }));

    const prune = rec.updates.find((u) => u.table === "documents")!;
    expect(prune.ids).toEqual(["old1", "old2"]);
    expect(prune.values.deleted_at).toBeTruthy();
    // `deleted_via` names which ancestor hid the row, which is 0040's own
    // description of the column. The consequence is the one that is wanted:
    // `workspace_trash` lists only rows with `deleted_via is null`, so a year
    // of aged-out digests does not arrive in Recently Deleted one a week
    // pretending somebody pressed something.
    expect(prune.values.deleted_via).toBe("r1");
    expect(prune.values.deleted_by).toBeNull();
  });

  it("still reports the filing when the prune fails", async () => {
    const { db, rec } = makeDb({ pruneError: { message: "statement timeout" } });

    const result = await fileRoutineOutput(db, {} as any, input());

    // The prune is the last thing that happens and the document already exists.
    // Keeping more documents than asked for is the harmless direction; turning
    // a successful filing into a note saying it did not happen is not.
    expect(result).toMatchObject({ filed: true, documentId: "d-new" });
    expect(rec.updates).toEqual([]);
  });
});
