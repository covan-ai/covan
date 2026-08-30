import { describe, it, expect } from "vitest";
import { archiveEntries, documentEntryName, type ArchiveContext } from "./archive";
import type { DocStore } from "../docstore";
import type { Collected } from "./collect";

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

function store(files: Record<string, string>, opts: { throwOn?: string } = {}): DocStore {
  return {
    async get(key) {
      if (opts.throwOn === key) throw new Error("store is down");
      if (!(key in files)) return null;
      const bytes = new TextEncoder().encode(files[key]);
      return {
        body: new ReadableStream(),
        async arrayBuffer() {
          return bytes.buffer.slice(0) as ArrayBuffer;
        },
      };
    },
    async put() {},
    async delete() {},
  };
}

function context(over: Partial<ArchiveContext> = {}): ArchiveContext {
  const tables: Collected = {
    workspaces: [{ id: "w1", name: "Acme", slug: "acme" }],
    workspace_members: [{ workspace_id: "w1", user_id: "u1", role: "admin" }],
    documents: [],
    ...(over.tables ?? {}),
  };
  return {
    workspace: { id: "w1", name: "Acme" },
    exportedBy: { userId: "u1", role: "admin" },
    exportedAt: "2026-08-31T00:00:00.000Z",
    store: store({}),
    ...over,
    tables,
  };
}

async function collect(ctx: ArchiveContext) {
  const out: { name: string; text: string }[] = [];
  for await (const e of archiveEntries(ctx)) out.push({ name: e.name, text: decode(e.data) });
  return out;
}

describe("what lands in the archive", () => {
  it("leads with the manifest, because it is what says how to read the rest", async () => {
    const entries = await collect(context());
    expect(entries[0].name).toBe("manifest.json");
  });

  it("carries the restore path beside the data", async () => {
    const names = (await collect(context())).map((e) => e.name);
    expect(names).toContain("workspace.sql");
    expect(names).toContain("restore.sh");
    expect(names).toContain("data/workspaces.json");
    expect(names).toContain("data/workspace_members.json");
  });

  it("says whose view it is, in the manifest rather than in a README nobody opens", async () => {
    const [manifest] = await collect(context());
    const parsed = JSON.parse(manifest.text);

    expect(parsed.exportedBy).toEqual({ userId: "u1", role: "admin" });
    expect(parsed.scope).toMatch(/Row level security/);
    expect(parsed.counts.workspaces).toBe(1);
  });

  it("names what it left behind and why", async () => {
    const [manifest] = await collect(context());
    const parsed = JSON.parse(manifest.text);

    // Somebody looking for their chunks should find the reason here, not in a
    // commit message.
    expect(Object.keys(parsed.excluded)).toContain("document_chunks");
    expect(Object.keys(parsed.excluded)).toContain("api_keys");
    expect(parsed.afterRestore).toMatch(/backfill-embeddings/);
    expect(parsed.afterRestore).toMatch(/ROUTINE_SECRET_KEY/);
  });
});

describe("the documents", () => {
  const withDocs = (files: Record<string, string>, throwOn?: string) =>
    context({
      tables: {
        documents: [
          { id: "d1", name: "notes.md", r2_key: "k1" },
          { id: "d2", name: "deck.pdf", r2_key: "k2" },
        ],
      } as Partial<Collected> as Collected,
      store: store(files, { throwOn }),
    });

  it("come out with their bytes", async () => {
    const entries = await collect(withDocs({ k1: "hello", k2: "world" }));
    const doc = entries.find((e) => e.name.endsWith("notes.md"));
    expect(doc?.text).toBe("hello");
  });

  it("do not stop the export when one is gone from storage", async () => {
    // A row pointing at a missing object is a real state — an interrupted
    // upload, a bucket restored from an older copy — and refusing the whole
    // archive over it would deny somebody every document they still have.
    const entries = await collect(withDocs({ k1: "hello" }));
    const warnings = JSON.parse(entries.at(-1)!.text);

    expect(entries.some((e) => e.name.endsWith("notes.md"))).toBe(true);
    expect(warnings.missingDocuments).toEqual([
      { id: "d2", name: "deck.pdf", reason: "the stored file is gone" },
    ]);
  });

  it("do not stop the export when the store itself fails", async () => {
    const entries = await collect(withDocs({ k1: "hello", k2: "world" }, "k2"));
    const warnings = JSON.parse(entries.at(-1)!.text);
    expect(warnings.missingDocuments[0].reason).toMatch(/could not be read/);
  });

  it("record a row that never had a file", async () => {
    const ctx = context({
      tables: {
        documents: [{ id: "d3", name: "pasted.txt", r2_key: null }],
      } as unknown as Collected,
    });
    const warnings = JSON.parse((await collect(ctx)).at(-1)!.text);
    expect(warnings.missingDocuments[0].reason).toMatch(/no stored file/);
  });

  it("write the warnings file even when there is nothing to warn about", async () => {
    // An archive where a missing warnings file means "all fine" and a truncated
    // download also means "all fine" cannot tell you which one you have.
    const entries = await collect(context());
    expect(entries.at(-1)!.name).toBe("data/export-warnings.json");
    expect(JSON.parse(entries.at(-1)!.text)).toEqual({ missingDocuments: [] });
  });
});

describe("the name a document gets inside the archive", () => {
  it("keeps the original, prefixed by the row id", () => {
    // Two documents in one workspace may share a name, and an archive where the
    // second silently replaces the first has lost a file.
    expect(documentEntryName("d1", "notes.md")).toBe("documents/d1-notes.md");
    expect(documentEntryName("d2", "notes.md")).toBe("documents/d2-notes.md");
  });

  it("cannot escape the documents folder", () => {
    // The oldest trick against anyone extracting an archive: a path that walks
    // out of the directory they extracted into.
    expect(documentEntryName("d1", "../../.ssh/authorized_keys")).toBe(
      "documents/d1-____.ssh_authorized_keys",
    );
    expect(documentEntryName("d1", "/etc/passwd")).toBe("documents/d1-_etc_passwd");
  });

  it("strips control characters and leading dots", () => {
    expect(documentEntryName("d1", "a\nb\tc.md")).toBe("documents/d1-a_b_c.md");
    expect(documentEntryName("d1", ".bashrc")).toBe("documents/d1-_bashrc");
  });

  it("keeps a non-ASCII name, which the archive can hold", () => {
    expect(documentEntryName("d1", "toplantı.md")).toBe("documents/d1-toplantı.md");
  });

  it("never produces an empty name", () => {
    expect(documentEntryName("d1", "")).toBe("documents/d1-document");
  });
});
