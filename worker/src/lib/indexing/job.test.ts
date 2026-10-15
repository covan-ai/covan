import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../extract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../extract")>()),
  // Small enough to cut a test document, so `partial` can be seen.
  MAX_INDEX_CHARS: 400_000,
}));
vi.mock("../embeddings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../embeddings")>()),
  embedTexts: vi.fn(async (_env: unknown, texts: string[]) => ({
    vectors: texts.map(() => [0.1]),
    tokens: texts.length,
  })),
}));

import { fakeDb, type Filter, type QueryContext } from "../../test-support/fake-db";
import { getDocStore } from "../docstore";
import { embedTexts } from "../embeddings";
import { sidecarKey } from "../document-text";
import { advanceIndexJob, MAX_ATTEMPTS, UNIT } from "./job";

type Row = Record<string, unknown>;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "covan-index-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  vi.mocked(embedTexts).mockClear();
});

const env = () =>
  ({
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    OPENAI_API_KEY: "sk-test",
    DOCS_DIR: root,
  }) as never;

const matches = (row: Row, filters: Filter[]) =>
  filters.every((f) => {
    const v = row[f.column] as number;
    if (f.kind === "eq") return row[f.column] === f.value;
    if (f.kind === "lt") return v < (f.value as number);
    if (f.kind === "gte") return v >= (f.value as number);
    return true;
  });

/** A database holding one document and its passages, which the job changes. */
function world(doc: Row, passages: Row[] = []) {
  const state = { doc: { ...doc }, chunks: [...passages] };
  const fake = fakeDb({
    tables: {
      documents: {
        update: (ctx: QueryContext) => {
          Object.assign(state.doc, ctx.values);
          return { data: null, error: null };
        },
        select: () => ({ data: state.doc, error: null }),
      },
      knowledge_bundles: { select: () => ({ data: { workspace_id: "ws-1" }, error: null }) },
      document_chunks: {
        select: (ctx: QueryContext) => {
          // The count `fail` asks for selects only the id.
          if (ctx.columns === "id") {
            return {
              data: null,
              count: state.chunks.filter((c) => matches(c, ctx.filters)).length,
              error: null,
            };
          }
          const sorted = [...state.chunks].sort(
            (a, b) => (b.generation as number) - (a.generation as number),
          );
          return { data: sorted.slice(0, 1), error: null };
        },
        insert: (ctx: QueryContext) => {
          state.chunks.push(...(ctx.values as unknown as Row[]));
          return { data: null, error: null };
        },
        delete: (ctx: QueryContext) => {
          state.chunks = state.chunks.filter((c) => !matches(c, ctx.filters));
          return { data: null, error: null };
        },
      },
    },
    rpc: {
      claim_index_job: () => {
        const s = state.doc.index_status;
        return { data: s === "queued" || s === "indexing" ? [{ ...state.doc }] : [], error: null };
      },
    },
  });
  return { state, db: fake.db as never };
}

async function store(key: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  await getDocStore({ DOCS_DIR: root } as never).put(key, bytes.buffer as ArrayBuffer, {
    contentType: "text/plain",
  });
}

const queued = (over: Row = {}): Row => ({
  id: "d1",
  name: "handbook.md",
  bundle_id: "b1",
  r2_key: "b1/handbook",
  content: "",
  created_by: "user-1",
  index_status: "queued",
  index_cursor: 0,
  index_total: null,
  index_generation: null,
  index_attempts: 0,
  index_truncated: false,
  index_lease_until: null,
  ...over,
});

/** Advance until the job says it is done, counting the units. */
async function drive(db: never, limit = 50): Promise<number> {
  let units = 0;
  for (; units < limit; units++) {
    const next = await advanceIndexJob(db, env(), "d1");
    if (next.next === "none") return units + 1;
  }
  throw new Error("did not finish");
}

const sentences = (n: number) =>
  Array.from({ length: n }, (_, i) => `Sentence number ${i} says something about leave.`).join(" ");

describe("advanceIndexJob", () => {
  it("indexes a document a unit at a time and replaces its old passages at the end", async () => {
    await store("b1/handbook", sentences(5000)); // ~250,000 chars, past one unit
    const old = { document_id: "d1", generation: 0, chunk_index: 0, content: "old" };
    const { state, db } = world(queued(), [old]);

    const units = await drive(db);

    expect(state.doc.index_status).toBe("ready");
    expect(state.doc.index_total).toBeGreaterThan(0);
    expect(state.chunks).toHaveLength(state.doc.index_total as number);
    expect(state.chunks.every((c) => c.generation === 1)).toBe(true);
    // The text the job read is kept, so no later unit opens the original again.
    const sidecar = await getDocStore({ DOCS_DIR: root } as never).get(sidecarKey("b1/handbook"));
    expect(sidecar).not.toBeNull();
    expect((state.doc.content as string).length).toBeGreaterThan(0);
    expect(units).toBe(1 + Math.ceil((state.doc.index_total as number) / UNIT));
  });

  it("keeps the old passages until the new set is complete", async () => {
    await store("b1/handbook", sentences(5000));
    const old = { document_id: "d1", generation: 0, chunk_index: 0, content: "old" };
    const { state, db } = world(queued(), [old]);

    await advanceIndexJob(db, env(), "d1"); // reads the text
    await advanceIndexJob(db, env(), "d1"); // first passages in

    expect(state.doc.index_status).toBe("indexing");
    expect(state.chunks).toContainEqual(old);
  });

  it("marks a document cut at the indexing limit as partial", async () => {
    await store("b1/handbook", sentences(9000)); // past the mocked 400,000
    const { state, db } = world(queued());

    await drive(db);

    expect(state.doc.index_status).toBe("partial");
    expect(state.doc.index_truncated).toBe(true);
  });

  // Fails before a credit is spent: nothing is embedded for a file whose text
  // cannot be read.
  it("fails a file that is not what its name says, and embeds nothing", async () => {
    await store("b1/deck", "this is not a zip archive at all");
    const { state, db } = world(queued({ name: "deck.pptx", r2_key: "b1/deck" }));

    await drive(db);

    expect(state.doc.index_status).toBe("failed");
    expect(state.doc.index_error).toMatch(/does not read as a \.pptx file/);
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it("fails an old PDF that kept no text, rather than indexing nothing", async () => {
    await store("b1/scan", "%PDF-1.7 binary");
    const { state, db } = world(
      queued({ name: "scan.pdf", r2_key: "b1/scan", content: "x".repeat(8000) }),
    );

    await drive(db);

    expect(state.doc.index_status).toBe("failed");
    expect(state.doc.index_error).toMatch(/upload it again/);
  });

  it("retries a unit that failed, and gives up after the last attempt with the old passages kept", async () => {
    await store("b1/handbook", sentences(400));
    const old = { document_id: "d1", generation: 0, chunk_index: 0, content: "old" };
    const { state, db } = world(queued(), [old]);
    await advanceIndexJob(db, env(), "d1"); // reads the text

    vi.mocked(embedTexts).mockRejectedValue(new Error("embedding service down"));
    const first = await advanceIndexJob(db, env(), "d1");
    expect(first.next).toBe("at");
    expect(state.doc.index_attempts).toBe(1);

    for (let i = 1; i < MAX_ATTEMPTS; i++) await advanceIndexJob(db, env(), "d1");
    vi.mocked(embedTexts).mockReset();

    expect(state.doc.index_status).toBe("failed");
    expect(state.doc.index_error).toBe("embedding service down");
    expect(state.chunks).toEqual([old]);
  });

  it("does nothing for a document that is not queued", async () => {
    const { db } = world(queued({ index_status: "ready" }));
    expect(await advanceIndexJob(db, env(), "d1")).toEqual({ next: "none" });
  });
});

describe("advanceIndexJob with a scanned PDF", () => {
  it("reads it with OCR when it has no text of its own, and charges for the read", async () => {
    const ocr = await import("../formats/read/ocr");
    const spy = vi.spyOn(ocr, "ocrPdf").mockResolvedValue({
      text: sentences(300),
      truncated: false,
      model: "claude-haiku-4-5",
      usage: { promptTokens: 1200, completionTokens: 900 },
    });
    await store("b1/scan", "%PDF-1.7 a page of pixels");
    const { state, db } = world(queued({ name: "scan.pdf", r2_key: "b1/scan", content: "" }));

    const ocrEnv = { ...(env() as object), ANTHROPIC_API_KEY: "sk-ant-test" } as never;
    for (let i = 0; i < 10; i++) {
      if ((await advanceIndexJob(db, ocrEnv, "d1")).next === "none") break;
    }

    expect(spy).toHaveBeenCalledTimes(1);
    expect(state.doc.index_status).toBe("ready");
    expect(state.chunks.length).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it("fails it with the reason when this deployment cannot read scans", async () => {
    await store("b1/scan", "%PDF-1.7 a page of pixels");
    const { state, db } = world(queued({ name: "scan.pdf", r2_key: "b1/scan", content: "" }));

    await drive(db);

    expect(state.doc.index_status).toBe("failed");
  });
});
