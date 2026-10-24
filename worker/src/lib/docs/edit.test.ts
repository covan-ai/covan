import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type QueryContext } from "../../test-support/fake-db";
import { getDocStore } from "../docstore";
import type { DocumentEnv } from "../../types";
import {
  applyEdits,
  copyName,
  editableInPlace,
  findAgentDocument,
  saveDocumentText,
  splitWritten,
  type FoundDocument,
} from "./edit";

const kickIndexJob = vi.fn();
vi.mock("../indexing/host", () => ({
  kickIndexJob: (...args: unknown[]) => kickIndexJob(...args),
}));

let service: ReturnType<typeof fakeDb>;
vi.mock("../supabase", () => ({
  serviceClient: () => service.db,
}));

const BUNDLE = "11111111-1111-4111-8111-111111111111";
const DOC_ID = "22222222-2222-4222-8222-222222222222";

describe("applyEdits", () => {
  it("replaces one exact occurrence", () => {
    const out = applyEdits("Launch is on Monday.", [{ find: "Monday", replace: "Friday" }]);
    expect(out).toEqual({ kind: "ok", text: "Launch is on Friday.", changed: 1 });
  });

  it("applies edits in order, each to the result of the one before", () => {
    const out = applyEdits("a b c", [
      { find: "a", replace: "x" },
      { find: "x b", replace: "y" },
    ]);
    expect(out).toMatchObject({ kind: "ok", text: "y c" });
  });

  it("refuses a find that is not there, and changes nothing", () => {
    const out = applyEdits("Launch is on Monday.", [
      { find: "Launch", replace: "Release" },
      { find: "Tuesday", replace: "Friday" },
    ]);
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.message).toMatch(/edit 2: .*does not appear/);
  });

  it("refuses an ambiguous find unless all is set, and says how many", () => {
    const text = "TODO one. TODO two.";
    const refused = applyEdits(text, [{ find: "TODO", replace: "DONE" }]);
    expect(refused.kind).toBe("error");
    if (refused.kind === "error") expect(refused.message).toMatch(/appears 2 times/);
    expect(applyEdits(text, [{ find: "TODO", replace: "DONE", all: true }])).toEqual({
      kind: "ok",
      text: "DONE one. DONE two.",
      changed: 2,
    });
  });

  it("refuses an empty find", () => {
    expect(applyEdits("x", [{ find: "", replace: "y" }]).kind).toBe("error");
  });
});

describe("splitWritten", () => {
  it("reads back what the engine assembles", () => {
    const text = "# Q3 review\n\n## Revenue\n\nUp.\n\n## Costs\n\nDown.\n";
    expect(splitWritten(text)).toEqual({
      title: "Q3 review",
      sections: [
        { heading: "Revenue", body: "Up." },
        { heading: "Costs", body: "Down." },
      ],
    });
  });

  it("keeps text before the first part as a part of its own", () => {
    expect(splitWritten("# T\n\nIntro.\n\n## A\n\nBody").sections).toEqual([
      { heading: "", body: "Intro." },
      { heading: "A", body: "Body" },
    ]);
  });
});

describe("copyName and editableInPlace", () => {
  it("names a copy after its original", () => {
    expect(copyName("Contract.docx")).toBe("Contract (edited).md");
    expect(copyName("notes")).toBe("notes (edited).md");
  });

  it("edits text files in place, but not containers or synced files", () => {
    expect(editableInPlace({ name: "plan.md", connection_id: null })).toBe(true);
    expect(editableInPlace({ name: "data.csv", connection_id: null })).toBe(true);
    expect(editableInPlace({ name: "deck.pdf", connection_id: null })).toBe(false);
    expect(editableInPlace({ name: "page.md", connection_id: "conn-1" })).toBe(false);
  });
});

describe("findAgentDocument", () => {
  const row = {
    id: DOC_ID,
    name: "Onboarding checklist.md",
    bundle_id: BUNDLE,
    r2_key: null,
    content: null,
    size: 10,
    connection_id: null,
    index_status: "ready",
    index_lease_until: null,
    created_at: null,
    knowledge_bundles: { name: "Team", workspace_id: "ws-1" },
  };

  function asker(documents: (ctx: QueryContext) => { data: unknown; error: null }) {
    const db = fakeDb({
      tables: {
        agent_bundles: { select: () => ({ data: [{ bundle_id: BUNDLE }], error: null }) },
        documents: { select: documents },
      },
    });
    return { asker: { db: db.db as never, agentId: "agent-1", workspaceId: "ws-1" }, db };
  }

  it("finds by id, only within the agent's bundles", async () => {
    const { asker: a, db } = asker(() => ({ data: row, error: null }));
    const found = await findAgentDocument(a, DOC_ID);
    expect(found).toMatchObject({ kind: "found", doc: { id: DOC_ID, bundle_name: "Team" } });
    const read = db.calls.find((c) => c.table === "documents");
    expect(read?.filters).toContainEqual({ column: "bundle_id", value: [BUNDLE], kind: "in" });
  });

  it("refuses a document from another workspace even if a row came back", async () => {
    const other = { ...row, knowledge_bundles: { name: "X", workspace_id: "ws-2" } };
    const { asker: a } = asker(() => ({ data: other, error: null }));
    expect((await findAgentDocument(a, DOC_ID)).kind).toBe("none");
  });

  it("names the candidates back when a name is ambiguous", async () => {
    const two = [
      { ...row, id: "a", name: "Checklist v1.md" },
      { ...row, id: "b", name: "Checklist v2.md" },
    ];
    const { asker: a } = asker(() => ({ data: two, error: null }));
    const found = await findAgentDocument(a, "checklist");
    expect(found.kind).toBe("ambiguous");
    if (found.kind === "ambiguous") expect(found.message).toContain("(id: b)");
  });
});

describe("saveDocumentText", () => {
  let dir: string;
  let env: DocumentEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "covan-edit-"));
    env = { DOCS_DIR: dir } as unknown as DocumentEnv;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const doc = (over: Partial<FoundDocument> = {}): FoundDocument => ({
    id: DOC_ID,
    name: "Plan.md",
    bundle_id: BUNDLE,
    bundle_name: "Reports",
    workspace_id: "ws-1",
    r2_key: `${BUNDLE}/33333333-3333-4333-8333-333333333333-Plan.md`,
    content: "old",
    size: 3,
    connection_id: null,
    index_status: "ready",
    index_lease_until: null,
    created_at: null,
    ...over,
  });

  it("asks the database first, then writes the new file over the row and re-indexes it", async () => {
    const original = doc();
    const store = getDocStore(env);
    await store.put(original.r2_key!, new TextEncoder().encode("old").buffer as ArrayBuffer, {
      contentType: "text/markdown",
    });
    const caller = fakeDb({
      tables: { documents: { update: () => ({ data: { id: DOC_ID }, error: null }) } },
    });
    service = fakeDb({
      tables: {
        documents: { update: () => ({ data: { id: DOC_ID }, error: null }) },
        document_jobs: { select: () => ({ data: [], error: null }) },
      },
    });

    const saved = await saveDocumentText(
      { db: caller.db as never, agentId: "agent-1", workspaceId: "ws-1", env },
      original,
      "# Plan\n\nnew",
    );

    expect(saved).toEqual({ kind: "replaced", documentId: DOC_ID, name: "Plan.md" });
    // The probe touched nothing but the name, through the caller's client.
    expect(caller.calls[0].values).toEqual({ name: "Plan.md" });
    const write = service.calls.find((c) => c.table === "documents")!;
    expect(write.values).toMatchObject({ content: "# Plan\n\nnew", index_status: "queued" });
    expect(write.filters).toContainEqual({ column: "r2_key", value: original.r2_key, kind: "eq" });
    const newKey = write.values!.r2_key as string;
    const stored = await store.get(newKey);
    expect(new TextDecoder().decode(await stored!.arrayBuffer())).toBe("# Plan\n\nnew");
    expect(await store.get(original.r2_key!)).toBeNull();
    expect(kickIndexJob).toHaveBeenCalledWith(env, DOC_ID);
  });

  it("writes nothing when the database says this person may not change it", async () => {
    const caller = fakeDb({
      tables: { documents: { update: () => ({ data: null, error: null }) } },
    });
    service = fakeDb({ tables: {} });
    const saved = await saveDocumentText(
      { db: caller.db as never, agentId: "agent-1", workspaceId: "ws-1", env },
      doc(),
      "new",
    );
    expect(saved.kind).toBe("error");
    expect(service.calls).toHaveLength(0);
    expect(kickIndexJob).not.toHaveBeenCalled();
  });

  it("puts the stored file back when the row changed underneath the edit", async () => {
    const caller = fakeDb({
      tables: { documents: { update: () => ({ data: { id: DOC_ID }, error: null }) } },
    });
    service = fakeDb({
      tables: { documents: { update: () => ({ data: null, error: null }) } },
    });
    const saved = await saveDocumentText(
      { db: caller.db as never, agentId: "agent-1", workspaceId: "ws-1", env },
      doc(),
      "new",
    );
    expect(saved.kind).toBe("error");
    if (saved.kind === "error") expect(saved.message).toMatch(/changed while/);
    const newKey = service.calls[0].values!.r2_key as string;
    expect(await getDocStore(env).get(newKey)).toBeNull();
  });

  it("refreshes the sections of the job that wrote it, so its card shows the edit", async () => {
    const caller = fakeDb({
      tables: { documents: { update: () => ({ data: { id: DOC_ID }, error: null }) } },
    });
    service = fakeDb({
      tables: {
        documents: { update: () => ({ data: { id: DOC_ID }, error: null }) },
        document_jobs: {
          select: () => ({ data: [{ id: "job-1", title: "Plan" }], error: null }),
          update: () => ({ data: null, error: null }),
        },
        document_sections: {
          delete: () => ({ data: null, error: null }),
          insert: () => ({ data: null, error: null }),
        },
      },
    });
    await saveDocumentText(
      { db: caller.db as never, agentId: "agent-1", workspaceId: "ws-1", env },
      doc(),
      "# Plan\n\n## One\n\nFirst.\n\n## Two\n\nSecond.",
    );
    const inserted = service.calls.find(
      (c) => c.table === "document_sections" && c.op === "insert",
    );
    expect(inserted?.values).toEqual([
      { job_id: "job-1", idx: 0, heading: "One", brief: "", body: "First.", status: "done" },
      { job_id: "job-1", idx: 1, heading: "Two", brief: "", body: "Second.", status: "done" },
    ]);
    const job = service.calls.find((c) => c.table === "document_jobs" && c.op === "update");
    expect(job?.values).toMatchObject({ title: "Plan", cursor: 2 });
  });

  it("saves an edited Markdown copy beside a file that cannot be changed in place", async () => {
    const caller = fakeDb({
      tables: { documents: { insert: () => ({ data: { id: "copy-1" }, error: null }) } },
    });
    service = fakeDb({ tables: {} });
    const saved = await saveDocumentText(
      { db: caller.db as never, agentId: "agent-1", workspaceId: "ws-1", env },
      doc({ name: "Contract.docx" }),
      "edited",
    );
    expect(saved).toEqual({ kind: "copied", documentId: "copy-1", name: "Contract (edited).md" });
    const insert = caller.calls[0];
    expect(insert.values).toMatchObject({
      bundle_id: BUNDLE,
      name: "Contract (edited).md",
      index_status: "queued",
    });
    // A key the client-writes guard (0085) accepts: a new key under the bundle.
    expect(String(insert.values!.r2_key)).toMatch(
      new RegExp(`^${BUNDLE}/[0-9a-f-]{36}-Contract__edited_\\.md$`),
    );
    expect(service.calls).toHaveLength(0);
    expect(kickIndexJob).toHaveBeenCalledWith(env, "copy-1");
  });
});
