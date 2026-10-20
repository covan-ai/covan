import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { fakeProvider } = vi.hoisted(() => ({
  fakeProvider: {
    id: "notion",
    label: "Notion",
    isConfigured: vi.fn(() => true),
    authorizeUrl: vi.fn(() => "https://example.com"),
    exchangeCode: vi.fn(),
    refresh: vi.fn(async (_env: unknown, token: unknown) => token),
    listFiles: vi.fn(),
    readFile: vi.fn(),
  },
}));
vi.mock("./registry", () => ({
  providerFor: (id: string) => (id === "unknown" ? null : fakeProvider),
  providerAvailability: () => [],
}));

// Real chunking, fake vectors: what this file is about is which rows move, and
// a network call to OpenAI would decide none of it.
vi.mock("../embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings")>();
  return {
    ...actual,
    embedTexts: vi.fn(async (_env: unknown, texts: string[]) => ({
      vectors: texts.map(() => [0.1, 0.2]),
      tokens: 100 * texts.length,
    })),
  };
});

// Claude's reading of a scan, without Claude: what is tested here is when the
// sync asks and what it charges, not the transcript.
vi.mock("../formats/read/ocr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../formats/read/ocr")>();
  return {
    ...actual,
    ocrPdf: vi.fn(async () => ({
      text: "Signed by both parties on 1 March.",
      truncated: false,
      model: "claude-haiku-4-5",
      usage: { promptTokens: 2000, completionTokens: 40 },
    })),
  };
});

import { fakeDb, type QueryContext } from "../../test-support/fake-db";
import { getDocStore } from "../docstore";
import { sidecarKey } from "../document-text";
import { ocrPdf } from "../formats/read/ocr";
import { embedTexts } from "../embeddings";
import { runConnection, isNarrowing, MAX_DOCUMENTS_PER_RUN, type ConnectionRow } from "./sync";
import { encryptSecret } from "../secret-box";
import { FileSkip, ProviderError } from "./types";

/** Every `external_version` the run wrote, in order. */
function versionWrites(fake: { callsTo: (t: string) => QueryContext[] }): unknown[] {
  return fake
    .callsTo("documents")
    .filter((c) => c.op === "update" && c.values && "external_version" in c.values)
    .map((c) => (c.values as { external_version: unknown }).external_version);
}

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const NOW = new Date("2026-09-02T12:00:00.000Z");

let docsDir: string;

const env = () => ({
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  OPENAI_API_KEY: "sk-test",
  ROUTINE_SECRET_KEY: KEY,
  RESEND_API_KEY: "",
  RESEND_FROM: "",
  ALLOWED_ORIGIN: "https://app.example.com",
  DOCS_DIR: docsDir,
});

const unlimited = {
  check: vi.fn(async () => ({ allowed: true }) as const),
  record: vi.fn(async () => {}),
  snapshot: vi.fn(async () => ({ metered: false as const })),
};

async function connection(overrides: Partial<ConnectionRow> = {}): Promise<ConnectionRow> {
  return {
    id: "conn-1",
    workspace_id: "ws-1",
    bundle_id: "bundle-1",
    user_id: "user-1",
    provider: "notion",
    account_label: "Covan HQ",
    secret_ciphertext: await encryptSecret(JSON.stringify({ accessToken: "at" }), KEY),
    config: {},
    status: "active",
    sync_interval_minutes: 360,
    consecutive_failures: 0,
    ...overrides,
  };
}

const file = (id: string, version = "v1") => ({
  externalId: id,
  name: `${id}.md`,
  version,
  url: `https://notion.so/${id}`,
});

/** A database with a member, the given documents, and everything else empty. */
function db(
  options: {
    documents?: Array<Record<string, unknown>>;
    member?: boolean;
    /**
     * The owner's active workspace, for the two reads `getActiveWorkspaceId`
     * makes on the way to a workspace's own provider key. `null` — the default
     * — is a person with no active workspace, which is where the key lookup
     * gives up and the operator's keys answer.
     */
    activeWorkspace?: string | null;
    /** The connection's bundle is in Recently Deleted. */
    bundleTrashed?: boolean;
    /** How many passages the workspace already holds, for the ceiling. */
    passages?: number;
  } = {},
) {
  const documents = options.documents ?? [];
  const activeWorkspace = options.activeWorkspace ?? null;
  return fakeDb({
    tables: {
      profiles: {
        select: () => ({ data: { active_workspace_id: activeWorkspace }, error: null }),
      },
      workspace_members: {
        select: () => ({
          data:
            options.member === false ? null : { user_id: "user-1", workspace_id: activeWorkspace },
          error: null,
        }),
      },
      connections: { update: () => ({ data: null, error: null }) },
      knowledge_bundles: {
        select: () => ({
          data: { deleted_at: options.bundleTrashed ? NOW.toISOString() : null },
          error: null,
        }),
      },
      connection_runs: { insert: () => ({ data: null, error: null }) },
      documents: {
        select: () => ({ data: documents, error: null }),
        insert: (ctx: QueryContext) => ({
          data: { id: `doc-${ctx.values?.external_id}` },
          error: null,
        }),
        update: (ctx: QueryContext) => {
          if (ctx.single) return { data: { id: "doc-existing" }, error: null };
          // A bulk update is either the adoption pass or the soft delete; both
          // are keyed by an `in` filter, and both are answered with the rows
          // they named.
          const ids = ctx.filters.find((f) => f.kind === "in" && f.column === "id")?.value;
          return { data: Array.isArray(ids) ? ids.map((id) => ({ id })) : [], error: null };
        },
        delete: (ctx: QueryContext) => ({
          data: (ctx.filters.find((f) => f.kind === "in")?.value as string[]).map((id) => ({ id })),
          error: null,
        }),
      },
      document_chunks: {
        select: () => ({ data: [], error: null, count: options.passages ?? 0 }),
        delete: () => ({ data: null, error: null }),
        insert: () => ({ data: null, error: null }),
      },
    },
  });
}

const deps = (fake: ReturnType<typeof fakeDb>) => ({
  db: fake.db as never,
  env: env(),
  entitlements: unlimited,
  fetchImpl: (async () => new Response("")) as unknown as typeof fetch,
  now: () => NOW,
});

beforeEach(() => {
  docsDir = mkdtempSync(join(tmpdir(), "covan-sync-"));
  vi.clearAllMocks();
  fakeProvider.isConfigured.mockReturnValue(true);
  fakeProvider.refresh.mockImplementation(async (_env: unknown, token: unknown) => token);
});

afterEach(() => {
  rmSync(docsDir, { recursive: true, force: true });
});

describe("syncing a connection", () => {
  it("imports a document the bundle has never seen", async () => {
    fakeProvider.listFiles.mockResolvedValue([file("page-1")]);
    fakeProvider.readFile.mockResolvedValue("# Handbook\n\nTwenty days of leave a year.");
    const fake = db();

    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome).toMatchObject({ status: "ok", added: 1, updated: 0, removed: 0 });

    const inserted = fake.callsTo("documents").find((c) => c.op === "insert");
    expect(inserted?.values).toMatchObject({
      bundle_id: "bundle-1",
      connection_id: "conn-1",
      external_id: "page-1",
      external_url: "https://notion.so/page-1",
      name: "page-1.md",
    });
    // The version is what marks the file done, so it is written last, once
    // the passages are in — never with the row.
    expect(inserted?.values).not.toHaveProperty("external_version");
    expect(versionWrites(fake)).toEqual(["v1"]);
    // The excerpt the no-match fallback reads, same as an upload.
    expect(inserted?.values?.content).toContain("Twenty days");
    const chunkInsert = fake.callsTo("document_chunks").find((c) => c.op === "insert");
    expect(chunkInsert).toBeTruthy();
    // `insertChunkRows` passes the whole row array as the insert payload, so
    // `values` here is that array, not a single record — every row carries
    // the file's name as `context`, so a name/title search finds this
    // document even when the passage text never says it.
    const chunkRows = chunkInsert?.values as unknown as Array<{ context?: string }>;
    expect(chunkRows.length).toBeGreaterThan(0);
    expect(chunkRows.every((row) => row.context === "page-1.md")).toBe(true);
  });

  // A healthy connection over an unchanged folder must not read as a broken one.
  it("does nothing, and says so, when nothing has changed", async () => {
    fakeProvider.listFiles.mockResolvedValue([file("page-1")]);
    const fake = db({
      documents: [
        { id: "doc-1", external_id: "page-1", external_version: "v1", r2_key: "bundle-1/old" },
      ],
    });

    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome).toMatchObject({ status: "skipped", added: 0, updated: 0, removed: 0 });
    expect(fakeProvider.readFile).not.toHaveBeenCalled();
    expect(fake.callsTo("documents").some((c) => c.op === "insert")).toBe(false);
  });

  it("re-imports a document whose version moved, replacing its passages", async () => {
    fakeProvider.listFiles.mockResolvedValue([file("page-1", "v2")]);
    fakeProvider.readFile.mockResolvedValue("Thirty days of leave a year.");
    const fake = db({
      documents: [
        { id: "doc-1", external_id: "page-1", external_version: "v1", r2_key: "bundle-1/old" },
      ],
    });

    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome).toMatchObject({ status: "ok", added: 0, updated: 1 });
    expect(versionWrites(fake)).toEqual(["v2"]);
    // Stale passages have to go, or the old answer keeps being retrievable.
    expect(fake.callsTo("document_chunks").some((c) => c.op === "delete")).toBe(true);
  });

  // A synced document can be moved out of the bundle the connection feeds, and
  // the move takes its passages with it because retrieval reads scope from the
  // chunks. Re-importing used to write them back to `connection.bundle_id`,
  // which left the row in one bundle and everything searchable in it in
  // another — a document that is listed where it cannot be retrieved and
  // retrievable where it is not listed.
  it("re-imports a moved document into the bundle it was moved to", async () => {
    fakeProvider.listFiles.mockResolvedValue([file("page-1", "v2")]);
    fakeProvider.readFile.mockResolvedValue("Thirty days of leave a year.");
    const fake = db({
      documents: [
        {
          id: "doc-1",
          external_id: "page-1",
          external_version: "v1",
          r2_key: "bundle-1/old",
          bundle_id: "bundle-2",
        },
      ],
    });

    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome).toMatchObject({ status: "ok", updated: 1 });
    // The row is left where somebody put it — the update payload never mentions
    // the bundle — and the passages follow the row.
    const updated = fake.callsTo("documents").find((c) => c.op === "update" && c.single);
    expect(updated?.values).not.toHaveProperty("bundle_id");
    const chunkRows = fake.callsTo("document_chunks").find((c) => c.op === "insert")
      ?.values as unknown as Array<{ bundle_id?: string }>;
    expect(chunkRows.length).toBeGreaterThan(0);
    expect(chunkRows.every((row) => row.bundle_id === "bundle-2")).toBe(true);
  });

  // The half a changes feed cannot do, and the reason this engine lists instead.
  it("hides a document whose source file is gone, rather than destroying it", async () => {
    fakeProvider.listFiles.mockResolvedValue([]);
    const fake = db({
      documents: [
        {
          id: "doc-1",
          external_id: "page-1",
          external_version: "v1",
          r2_key: "bundle-1/old",
          deleted_at: null,
        },
      ],
    });

    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome).toMatchObject({ status: "ok", removed: 1 });

    const hidden = fake
      .callsTo("documents")
      .find((c) => c.op === "update" && "deleted_at" in (c.values ?? {}));
    expect(hidden?.filters).toContainEqual({ column: "id", value: ["doc-1"], kind: "in" });
    // Nobody did this — the source did — and 0040's rule is that a document
    // hidden on its own does not return with its bundle.
    expect(hidden?.values).toMatchObject({ deleted_by: null, deleted_via: null });

    // A folder that stops listing a file for an afternoon must not spend
    // somebody's thirty-day undo. The row and the object both stay.
    expect(fake.callsTo("documents").some((c) => c.op === "delete")).toBe(false);
  });

  it("brings a document back when the source has it again", async () => {
    fakeProvider.listFiles.mockResolvedValue([file("page-1")]);
    fakeProvider.readFile.mockResolvedValue("It is back, and unchanged.");
    const fake = db({
      documents: [
        {
          id: "doc-1",
          external_id: "page-1",
          external_version: "v1",
          r2_key: "bundle-1/old",
          deleted_at: "2026-09-01T00:00:00.000Z",
        },
      ],
    });

    const outcome = await runConnection(await connection(), deps(fake));

    // The version never moved while it was away, so only the mark can tell the
    // engine there is work here.
    expect(outcome).toMatchObject({ status: "ok", updated: 1 });
    const restored = fake.callsTo("documents").find((c) => c.op === "update" && c.single);
    expect(restored?.values).toMatchObject({ deleted_at: null });
  });

  // A person deleted it here. The file still being at the source is not a
  // reason to undo that, and charge for the embedding while doing it.
  it("leaves a document somebody deleted where they put it", async () => {
    fakeProvider.listFiles.mockResolvedValue([file("page-1", "v2")]);
    const fake = db({
      documents: [
        {
          id: "doc-1",
          external_id: "page-1",
          external_version: "v1",
          r2_key: "bundle-1/old",
          deleted_at: "2026-09-01T00:00:00.000Z",
          deleted_by: "user-1",
          deleted_via: null,
        },
      ],
    });

    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome).toMatchObject({ added: 0, updated: 0, removed: 0 });
    expect(fakeProvider.readFile).not.toHaveBeenCalled();
    // Neither re-imported nor un-deleted.
    const touched = fake
      .callsTo("documents")
      .filter((c) => c.op === "update" && c.values && "deleted_at" in c.values);
    expect(touched).toEqual([]);
  });

  it("syncs nothing into a bundle that is in Recently Deleted", async () => {
    fakeProvider.listFiles.mockResolvedValue([file("page-1")]);
    const fake = db({ bundleTrashed: true });

    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome.status).toBe("skipped");
    expect(fakeProvider.listFiles).not.toHaveBeenCalled();
    const connectionUpdate = fake.callsTo("connections").find((c) => c.op === "update");
    // Skipped, not paused: restoring the bundle is all it takes to resume.
    expect(connectionUpdate?.values).toMatchObject({ paused_reason: null });
  });

  it("records no version for a file whose passages could not be saved", async () => {
    fakeProvider.listFiles.mockResolvedValue([file("page-1", "v2")]);
    fakeProvider.readFile.mockResolvedValue("Thirty days of leave a year.");
    vi.mocked(embedTexts).mockRejectedValueOnce(new Error("embedding service down"));
    const fake = db({
      documents: [
        { id: "doc-1", external_id: "page-1", external_version: "v1", r2_key: "bundle-1/old" },
      ],
    });

    await runConnection(await connection(), deps(fake));

    // Still "v1" on the row, so the next run sees the file as changed and
    // tries again, rather than believing it is current.
    expect(versionWrites(fake)).toEqual([]);
  });

  // One file's problem is one file's. Drive answers an oversized export with a
  // 403, which used to pause the whole connection as a revoked grant.
  it("carries on past a file it cannot read, and names it", async () => {
    fakeProvider.listFiles.mockResolvedValue([
      file("big"),
      file("page-2"),
      { ...file("huge"), skipReason: "larger than 10 MB" },
    ]);
    fakeProvider.readFile.mockImplementation(async (_ctx: unknown, f: { externalId: string }) => {
      if (f.externalId === "big") throw new FileSkip("Google Drive will not export it");
      return "Some readable text about leave.";
    });
    const fake = db();

    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome).toMatchObject({ status: "ok", added: 1 });
    const run = fake.callsTo("connection_runs")[0]?.values as { error?: string };
    expect(run.error).toContain("big.md (Google Drive will not export it)");
    expect(run.error).toContain("huge.md (larger than 10 MB)");
    const connectionUpdate = fake.callsTo("connections").find((c) => c.op === "update");
    expect(connectionUpdate?.values).toMatchObject({ status: "active", paused_reason: null });
  });

  // Reconnecting a source, or restoring a workspace from an export, must not
  // import a second copy of everything.
  it("adopts documents it imported before the connection existed", async () => {
    fakeProvider.listFiles.mockResolvedValue([file("page-1")]);
    const fake = db({
      documents: [
        { id: "doc-1", external_id: "page-1", external_version: "v1", r2_key: "bundle-1/old" },
      ],
    });

    await runConnection(await connection(), deps(fake));

    const adoption = fake
      .callsTo("documents")
      .find((c) => c.op === "update" && c.values?.connection_id === "conn-1");
    expect(adoption?.filters).toContainEqual({
      column: "bundle_id",
      value: "bundle-1",
      kind: "eq",
    });
    expect(adoption?.filters).toContainEqual({ column: "connection_id", value: null, kind: "is" });
    expect(adoption?.filters).toContainEqual({
      column: "external_id",
      value: ["page-1"],
      kind: "in",
    });
  });

  // `connection_id` is a column on a row, not proof of ownership. Everything
  // this read returns is rewritten or has its stored object deleted, so a row
  // in another workspace's bundle naming this connection must never come back.
  it("reads only the connection's documents in its own workspace", async () => {
    fakeProvider.listFiles.mockResolvedValue([file("page-1")]);
    const fake = db({ documents: [] });

    await runConnection(await connection(), deps(fake));

    const existing = fake
      .callsTo("documents")
      .find(
        (c) =>
          c.op === "select" &&
          c.filters.some((f) => f.column === "connection_id" && f.value === "conn-1"),
      );
    expect(existing?.filters).toContainEqual({
      column: "knowledge_bundles.workspace_id",
      value: "ws-1",
      kind: "eq",
    });
  });

  it("stops at the run's ceiling and asks to come straight back", async () => {
    const many = Array.from({ length: MAX_DOCUMENTS_PER_RUN + 3 }, (_, i) => file(`page-${i}`));
    fakeProvider.listFiles.mockResolvedValue(many);
    fakeProvider.readFile.mockResolvedValue("Some readable text.");
    const fake = db();

    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome.added).toBe(MAX_DOCUMENTS_PER_RUN);
    expect(outcome.more).toBe(true);
    // A minute, not the six-hour interval: a first sync of a large folder has
    // to be able to finish.
    const scheduled = fake.callsTo("connections").find((c) => c.op === "update");
    expect(scheduled?.values?.next_sync_at).toBe(new Date(NOW.getTime() + 60_000).toISOString());
  });

  // An empty Notion page is not an error, and recording its version would stop
  // it importing itself the moment somebody writes in it.
  it("passes over a document with no readable text, without remembering it", async () => {
    fakeProvider.listFiles.mockResolvedValue([file("page-1")]);
    fakeProvider.readFile.mockResolvedValue("   ");
    const fake = db();

    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome).toMatchObject({ status: "skipped", added: 0 });
    expect(fake.callsTo("documents").some((c) => c.op === "insert")).toBe(false);
  });

  it("stores a refreshed token before it spends it", async () => {
    fakeProvider.refresh.mockResolvedValue({ accessToken: "fresh", refreshToken: "rt" });
    fakeProvider.listFiles.mockResolvedValue([]);
    const fake = db();

    await runConnection(await connection(), deps(fake));

    const write = fake
      .callsTo("connections")
      .find((c) => c.op === "update" && "secret_ciphertext" in (c.values ?? {}));
    expect(write).toBeDefined();
    // Written before the listing, so a run that dies mid-way has not thrown
    // away a token Google will not issue again.
    expect(fake.calls.indexOf(write!)).toBeLessThan(
      fake.calls.findIndex((c) => c.table === "connection_runs"),
    );
  });

  it("pauses on a revoked grant instead of retrying it every six hours", async () => {
    fakeProvider.listFiles.mockRejectedValue(new ProviderError("access revoked", false));
    const fake = db();

    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome.status).toBe("failed");
    const update = fake.callsTo("connections").find((c) => c.op === "update");
    expect(update?.values).toMatchObject({ status: "paused", paused_reason: "access revoked" });
  });

  it("leaves a temporary failure active, and backs off", async () => {
    fakeProvider.listFiles.mockRejectedValue(new ProviderError("Notion returned HTTP 503", true));
    const fake = db();

    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome.status).toBe("failed");
    const update = fake.callsTo("connections").find((c) => c.op === "update");
    expect(update?.values).toMatchObject({ status: "active", consecutive_failures: 1 });
    expect(Date.parse(update?.values?.next_sync_at as string)).toBeGreaterThan(
      NOW.getTime() + 360 * 60_000,
    );
  });

  it("pauses a transient failure once it has been failing for days", async () => {
    fakeProvider.listFiles.mockRejectedValue(new ProviderError("Notion returned HTTP 503", true));
    const fake = db();

    const outcome = await runConnection(await connection({ consecutive_failures: 19 }), deps(fake));

    expect(outcome.status).toBe("failed");
    expect(fake.callsTo("connections").find((c) => c.op === "update")?.values).toMatchObject({
      status: "paused",
    });
  });

  it("stops when the person who connected it has left the workspace", async () => {
    fakeProvider.listFiles.mockResolvedValue([file("page-1")]);
    const fake = db({ member: false });

    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome.status).toBe("skipped");
    expect(fakeProvider.listFiles).not.toHaveBeenCalled();
    expect(fake.callsTo("connections").find((c) => c.op === "update")?.values).toMatchObject({
      status: "paused",
    });
  });

  it("spends nothing once the workspace's credits are gone", async () => {
    const fake = db();
    const withQuota = {
      ...deps(fake),
      entitlements: {
        ...unlimited,
        check: vi.fn(async () => ({ allowed: false as const, balance: 0 })),
      },
    };

    const outcome = await runConnection(await connection(), withQuota);

    expect(outcome.status).toBe("skipped");
    expect(fakeProvider.listFiles).not.toHaveBeenCalled();
    // Left active on purpose: credits can be added, and a cursor-free sync
    // picks up exactly what it would have done.
    expect(fake.callsTo("connections").find((c) => c.op === "update")?.values).toMatchObject({
      status: "active",
    });
  });

  it("asks about, and charges, the connection's workspace — attributed to its owner", async () => {
    fakeProvider.listFiles.mockResolvedValue([file("page-1")]);
    fakeProvider.readFile.mockResolvedValue("Twenty days of leave a year.");
    const fake = db();
    const d = deps(fake);
    const row = await connection();

    await runConnection(row, d);

    expect(d.entitlements.check).toHaveBeenCalledWith(row.workspace_id);
    expect(d.entitlements.record).toHaveBeenCalledWith(
      row.workspace_id,
      [{ kind: "embedding", model: "text-embedding-3-small", tokens: 100, purpose: "sync" }],
      { connectionId: row.id, userId: row.user_id },
    );
  });

  it("pauses a connection whose provider this deployment no longer offers", async () => {
    fakeProvider.isConfigured.mockReturnValue(false);
    const fake = db();

    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome.status).toBe("failed");
    expect(
      fake.callsTo("connections").find((c) => c.op === "update")?.values?.paused_reason,
    ).toMatch(/not configured/);
  });

  it("records the run, whatever happened", async () => {
    fakeProvider.listFiles.mockResolvedValue([file("page-1")]);
    fakeProvider.readFile.mockResolvedValue("Readable enough.");
    const fake = db();

    await runConnection(await connection(), deps(fake));

    const run = fake.callsTo("connection_runs").find((c) => c.op === "insert");
    expect(run?.values).toMatchObject({
      connection_id: "conn-1",
      status: "ok",
      documents_added: 1,
      documents_updated: 0,
      documents_removed: 0,
    });
    expect(run?.values?.tokens).toBeGreaterThan(0);
  });
});

describe("a file that is more than its text", () => {
  const original = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

  // Stored as text under a `.docx` name, a synced Word file downloaded as a
  // text file and failed its next reindex trying to unzip prose.
  it("keeps the file as the source has it, and its text beside it", async () => {
    fakeProvider.listFiles.mockResolvedValue([{ ...file("plan"), name: "plan.docx" }]);
    fakeProvider.readFile.mockResolvedValue({ text: "Q3 hiring plan.", original });
    const fake = db();

    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome).toMatchObject({ status: "ok", added: 1 });
    const inserted = fake.callsTo("documents").find((c) => c.op === "insert")?.values as {
      r2_key: string;
      size: number;
    };
    expect(inserted.size).toBe(original.byteLength);
    const store = getDocStore(env());
    const stored = await store.get(inserted.r2_key);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(original);
    const sidecar = await store.get(sidecarKey(inserted.r2_key));
    expect(await new Response(await sidecar!.arrayBuffer()).text()).toBe("Q3 hiring plan.");
  });

  it("reads a scan with Claude, and charges the workspace for it", async () => {
    fakeProvider.listFiles.mockResolvedValue([{ ...file("deal"), name: "deal.pdf" }]);
    fakeProvider.readFile.mockResolvedValue({ text: "", original });
    const fake = db();

    const outcome = await runConnection(await connection(), {
      ...deps(fake),
      env: { ...env(), ANTHROPIC_API_KEY: "sk-ant-test" },
    });

    expect(outcome).toMatchObject({ status: "ok", added: 1 });
    expect(ocrPdf).toHaveBeenCalledTimes(1);
    const inserted = fake.callsTo("documents").find((c) => c.op === "insert")?.values;
    expect(inserted?.content).toContain("Signed by both parties");
    const spent = unlimited.record.mock.calls.flatMap(
      (call) => (call as unknown as [string, Array<{ kind: string; model?: string }>])[1],
    );
    expect(spent).toContainEqual(
      expect.objectContaining({ kind: "completion", model: "claude-haiku-4-5" }),
    );
  });

  it("names a file with no text it could read, rather than passing over it", async () => {
    fakeProvider.listFiles.mockResolvedValue([{ ...file("deal"), name: "deal.pdf" }]);
    fakeProvider.readFile.mockResolvedValue({ text: "", original });
    const fake = db();

    // No Anthropic key: nothing can read the scan.
    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome).toMatchObject({ status: "skipped", added: 0 });
    expect(ocrPdf).not.toHaveBeenCalled();
    const run = fake.callsTo("connection_runs")[0]?.values as { error?: string };
    expect(run.error).toContain("deal.pdf (no readable text in this PDF");
  });

  // Every file Drive lists now comes with a reason when it cannot be read, so
  // a folder of photos would otherwise fill each run's allowance with nothing.
  it("does not let files it cannot read take the run's allowance", async () => {
    const photos = Array.from({ length: MAX_DOCUMENTS_PER_RUN + 5 }, (_, i) => ({
      ...file(`photo-${i}`),
      name: `photo-${i}.jpg`,
      skipReason: "an image",
    }));
    fakeProvider.listFiles.mockResolvedValue([...photos, file("handbook")]);
    fakeProvider.readFile.mockResolvedValue("Twenty days of leave a year.");
    const fake = db();

    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome).toMatchObject({ status: "ok", added: 1, more: false });
    const run = fake.callsTo("connection_runs")[0]?.values as { error?: string };
    expect(run.error).toContain(`${photos.length} files were not imported`);
  });
});

describe("a synced document is indexed the way an upload is", () => {
  // Uploads embed each passage under its document's name; a sync used to
  // embed it bare, so a short Notion passage lost to the same words in an
  // upload (covan-cloud#438).
  it("embeds each passage under the document's name", async () => {
    fakeProvider.listFiles.mockResolvedValue([{ ...file("leave"), name: "Leave policy.md" }]);
    fakeProvider.readFile.mockResolvedValue("Twenty days a year.");

    await runConnection(await connection(), deps(db()));

    const embedded = vi.mocked(embedTexts).mock.calls[0][1];
    expect(embedded).toEqual(["Leave policy.md\n\nTwenty days a year."]);
  });

  it("holds a file the workspace has no room for, and names it", async () => {
    fakeProvider.listFiles.mockResolvedValue([file("big"), file("small")]);
    fakeProvider.readFile.mockResolvedValue("Some readable text about leave.");
    const fake = db({ passages: 10 });

    const outcome = await runConnection(await connection(), {
      ...deps(fake),
      env: { ...env(), WORKSPACE_MAX_PASSAGES: "10" },
    });

    expect(outcome).toMatchObject({ added: 0 });
    expect(embedTexts).not.toHaveBeenCalled();
    const run = fake.callsTo("connection_runs")[0]?.values as { error?: string };
    expect(run.error).toContain("this workspace's knowledge is full");
    // Not recorded, so it imports itself once there is room.
    expect(versionWrites(fake)).toEqual([]);
  });

  it("imports what fits under the ceiling", async () => {
    fakeProvider.listFiles.mockResolvedValue([file("page-1")]);
    fakeProvider.readFile.mockResolvedValue("Some readable text about leave.");

    const outcome = await runConnection(await connection(), {
      ...deps(db({ passages: 3 })),
      env: { ...env(), WORKSPACE_MAX_PASSAGES: "10" },
    });

    expect(outcome).toMatchObject({ status: "ok", added: 1 });
  });

  // Free's five is about fifty subrequests; Paid has ten thousand.
  it("imports more per run on a paid plan", async () => {
    const many = Array.from({ length: 25 }, (_, i) => file(`page-${i}`));
    fakeProvider.listFiles.mockResolvedValue(many);
    fakeProvider.readFile.mockResolvedValue("Some readable text.");

    const outcome = await runConnection(await connection(), {
      ...deps(db()),
      env: { ...env(), WORKER_PLAN: "paid" as const },
    });

    expect(outcome.added).toBe(20);
    expect(outcome.more).toBe(true);
  });
});

describe("the grant holder", () => {
  // 0057's `on delete set null` is what lets the row get here at all. Before
  // it, closing a Covan account DELETED the connection and left its documents
  // as orphans nothing could refresh.
  it("stops before anything when nobody holds it any more", async () => {
    const fake = db();

    const outcome = await runConnection(await connection({ user_id: null }), deps(fake));

    expect(outcome.status).toBe("skipped");
    // Not one call to the provider: there is no token that would work and no
    // allowance to charge, and the membership question below has no subject.
    expect(fakeProvider.listFiles).not.toHaveBeenCalled();
    expect(fake.callsTo("connections").find((c) => c.op === "update")?.values).toMatchObject({
      status: "paused",
      paused_code: "owner_gone",
    });
  });

  it("names the pause when they have left the workspace", async () => {
    const fake = db({ member: false });

    await runConnection(await connection(), deps(fake));

    // A different answer to a different problem: the person still exists and
    // could be added back, where `owner_gone` needs a new grant from somebody.
    expect(fake.callsTo("connections").find((c) => c.op === "update")?.values).toMatchObject({
      status: "paused",
      paused_code: "owner_left",
    });
  });
});

describe("what counts as the source showing less", () => {
  it("is a share of what is there, with a floor", () => {
    // The floor is what stops a small folder tripping on an ordinary tidy-up.
    expect(isNarrowing(3, 4)).toBe(false);
    expect(isNarrowing(4, 4)).toBe(false);
    expect(isNarrowing(5, 10)).toBe(true);
    // And the fraction is what keeps it proportionate to a large bundle: five
    // gone out of four hundred is somebody deleting files, not a narrower grant.
    expect(isNarrowing(5, 400)).toBe(false);
    expect(isNarrowing(80, 400)).toBe(true);
    expect(isNarrowing(280, 400)).toBe(true);
  });

  it("is never true of nothing", () => {
    expect(isNarrowing(0, 0)).toBe(false);
    expect(isNarrowing(0, 400)).toBe(false);
  });
});

/**
 * The protection without which `POST /connections/:id/reconnect` would be a
 * regression rather than a fix.
 *
 * Alice's grant saw 400 files, Bob's sees 120. A sync reconciles, so the next
 * run is entirely right — by its own rules — to conclude that 280 documents
 * have been deleted, and the team loses most of a bundle to somebody being
 * helpful. `MAX_REMOVALS_PER_RUN` does not help: it spreads the same 280 over
 * fourteen runs.
 */
describe("a source that suddenly shows much less", () => {
  const tenDocuments = Array.from({ length: 10 }, (_, i) => ({
    id: `doc-${i}`,
    external_id: `page-${i}`,
    external_version: "v1",
    r2_key: `bundle-1/${i}`,
    deleted_at: null,
  }));

  it("removes nothing and asks instead", async () => {
    // Two of ten still listed, so eight would go — past the floor and past a
    // fifth of the bundle.
    fakeProvider.listFiles.mockResolvedValue([file("page-0"), file("page-1")]);
    const fake = db({ documents: tenDocuments });

    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome).toMatchObject({ status: "skipped", removed: 0, added: 0, updated: 0 });
    // Nothing hidden. The soft delete is the one documents write that sets
    // `deleted_at` — the adoption pass above it is also a bulk update, and
    // matching on shape alone would count that as a removal.
    const hidden = fake
      .callsTo("documents")
      .filter((c) => c.op === "update" && c.values?.deleted_at !== undefined);
    expect(hidden).toEqual([]);

    const update = fake.callsTo("connections").find((c) => c.op === "update");
    expect(update?.values).toMatchObject({ status: "paused", paused_code: "access_narrowed" });
    // The sentence carries both numbers, because "some documents are missing"
    // is not something a person can act on.
    expect(update?.values?.paused_reason).toContain("8 of 10");
  });

  it("does not spend the new grant's allowance importing what it can still see", async () => {
    fakeProvider.listFiles.mockResolvedValue([file("page-0", "v2"), file("page-1", "v2")]);
    fakeProvider.readFile.mockResolvedValue("new text");
    const fake = db({ documents: tenDocuments });

    await runConnection(await connection(), deps(fake));

    // Stopping before the import half matters: re-embedding the survivors while
    // the bundle waits to find out whether the rest are really gone is paying
    // for work that a reconnect may undo.
    expect(fake.callsTo("documents").find((c) => c.op === "insert")).toBeUndefined();
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it("goes ahead once somebody has said so, and spends the permission", async () => {
    fakeProvider.listFiles.mockResolvedValue([file("page-0"), file("page-1")]);
    const fake = db({ documents: tenDocuments });

    const outcome = await runConnection(
      await connection({ removals_approved_at: "2026-09-02T11:00:00.000Z" }),
      deps(fake),
    );

    expect(outcome.removed).toBe(8);
    const update = fake.callsTo("connections").find((c) => c.op === "update");
    // Permission for one narrowing, not a standing exemption — otherwise the
    // next unexpected loss of access goes through without asking.
    expect(update?.values).toMatchObject({ removals_approved_at: null });
    expect(update?.values?.paused_code).toBeNull();
  });

  it("lets an ordinary tidy-up through untouched", async () => {
    // Three of four gone is most of this folder and is below the floor, which
    // is the right answer: "three of your three documents went" is a small
    // folder being emptied, not a grant that sees less.
    fakeProvider.listFiles.mockResolvedValue([file("page-0")]);
    const fake = db({ documents: tenDocuments.slice(0, 4) });

    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome.removed).toBe(3);
    expect(fake.callsTo("connections").find((c) => c.op === "update")?.values?.status).not.toBe(
      "paused",
    );
  });

  it("counts what is live, not what is already hidden", async () => {
    // Six already soft-deleted, four live, one still listed. Three of four
    // would go — below the floor. Counting the hidden six as well would make
    // this nine of ten and pause a connection over documents that went weeks
    // ago.
    const half = [
      ...tenDocuments.slice(0, 4),
      ...tenDocuments.slice(4).map((d) => ({ ...d, deleted_at: "2026-08-01T00:00:00.000Z" })),
    ];
    fakeProvider.listFiles.mockResolvedValue([file("page-0")]);
    const fake = db({ documents: half });

    const outcome = await runConnection(await connection(), deps(fake));

    expect(outcome.removed).toBe(3);
  });
});

describe("why the engine paused it", () => {
  it("says a grant was revoked rather than that something failed five times", async () => {
    fakeProvider.listFiles.mockRejectedValue(new ProviderError("access revoked", false));
    const fake = db();

    await runConnection(await connection(), deps(fake));

    // The interface offers Reconnect for this and Resume for the other, so the
    // two must not arrive as the same shape.
    expect(fake.callsTo("connections").find((c) => c.op === "update")?.values).toMatchObject({
      status: "paused",
      paused_code: "grant_revoked",
    });
  });

  it("says the deployment stopped offering the provider", async () => {
    fakeProvider.isConfigured.mockReturnValue(false);
    const fake = db();

    await runConnection(await connection(), deps(fake));

    expect(fake.callsTo("connections").find((c) => c.op === "update")?.values).toMatchObject({
      status: "paused",
      paused_code: "provider_unconfigured",
    });
  });

  it("clears the code when a run succeeds", async () => {
    fakeProvider.listFiles.mockResolvedValue([file("page-1")]);
    fakeProvider.readFile.mockResolvedValue("# Handbook");
    const fake = db();

    await runConnection(await connection(), deps(fake));

    // The sentence and the code are written together, always. A row carrying
    // one without the other says two different things about the same pause.
    const values = fake.callsTo("connections").find((c) => c.op === "update")?.values;
    expect(values?.paused_reason).toBeNull();
    expect(values?.paused_code).toBeNull();
  });
});

describe("draining an approved removal", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `doc-${i}`,
    external_id: `page-${i}`,
    external_version: "v1",
    r2_key: `bundle-1/${i}`,
    deleted_at: null,
  }));

  it("keeps the permission until the backlog is gone", async () => {
    // Forty documents, none still listed. The cap takes twenty a run, so
    // clearing the approval after the first twenty would pause the connection
    // and ask the same question of somebody who has already answered it.
    fakeProvider.listFiles.mockResolvedValue([]);
    const fake = db({ documents: many });

    const outcome = await runConnection(
      await connection({ removals_approved_at: "2026-09-02T11:00:00.000Z" }),
      deps(fake),
    );

    expect(outcome.removed).toBe(20);
    expect(outcome.more).toBe(true);
    const update = fake.callsTo("connections").find((c) => c.op === "update");
    expect(update?.values?.removals_approved_at).toBeUndefined();
  });

  it("and comes straight back for the rest rather than waiting out the interval", async () => {
    fakeProvider.listFiles.mockResolvedValue([]);
    const fake = db({ documents: many });

    await runConnection(
      await connection({ removals_approved_at: "2026-09-02T11:00:00.000Z" }),
      deps(fake),
    );

    // A minute, not six hours: forty at twenty a run would otherwise take two
    // sync intervals, and four hundred would take five days.
    const next = fake.callsTo("connections").find((c) => c.op === "update")?.values
      ?.next_sync_at as string;
    expect(new Date(next).getTime() - NOW.getTime()).toBeLessThanOrEqual(60_000);
  });
});
