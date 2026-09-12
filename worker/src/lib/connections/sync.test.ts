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

// `keysForUser` opens the workspace's stored key through `lib/keys/store`,
// which builds a service-role Supabase client of its own rather than using the
// `deps.db` fake — there is nothing here to point it at. Mocked to "no key
// set", which is what every test wants except the workspace-funded ones.
const { readWorkspaceKeys } = vi.hoisted(() => ({
  readWorkspaceKeys: vi.fn(async () => ({ openai: null, anthropic: null }) as WorkspaceKeys),
}));
vi.mock("../keys/store", () => ({ readWorkspaceKeys }));

import type { WorkspaceKeys } from "../keys/store";
import { fakeDb, type QueryContext } from "../../test-support/fake-db";
import { embedTexts } from "../embeddings";
import { runConnection, MAX_DOCUMENTS_PER_RUN, type ConnectionRow } from "./sync";
import { encryptSecret } from "../secret-box";
import { ProviderError } from "./types";

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
  snapshot: vi.fn(async () => ({ used: 0, limit: null, resetsAt: null })),
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
  // clearAllMocks wipes call history but leaves a mockResolvedValue installed
  // by an earlier test in place as the new default. Re-assert it.
  readWorkspaceKeys.mockResolvedValue({ openai: null, anthropic: null });
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
      external_version: "v1",
      external_url: "https://notion.so/page-1",
      name: "page-1.md",
    });
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
    const updated = fake.callsTo("documents").find((c) => c.op === "update" && c.single);
    expect(updated?.values).toMatchObject({ external_version: "v2" });
    // Stale passages have to go, or the old answer keeps being retrievable.
    expect(fake.callsTo("document_chunks").some((c) => c.op === "delete")).toBe(true);
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
    expect(restored?.values).toMatchObject({ deleted_at: null, external_version: "v1" });
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

  it("spends nothing once the owner's allowance is used up", async () => {
    const fake = db();
    const withQuota = {
      ...deps(fake),
      entitlements: {
        ...unlimited,
        check: vi.fn(async () => ({
          allowed: false as const,
          used: 300000,
          limit: 300000,
          resetsAt: "2026-10-01T00:00:00Z",
        })),
      },
    };

    const outcome = await runConnection(await connection(), withQuota);

    expect(outcome.status).toBe("skipped");
    expect(fakeProvider.listFiles).not.toHaveBeenCalled();
    // Left active on purpose: the allowance resets, and a cursor-free sync
    // picks up exactly what it would have done.
    expect(fake.callsTo("connections").find((c) => c.op === "update")?.values).toMatchObject({
      status: "active",
    });
  });

  /**
   * The workspace-funded branch, on a path with no request to guard.
   *
   * `guardQuota` covers this for every route that has a request; a scheduled
   * sync has none, so the same three-branch decision is made here by hand.
   * Both halves matter and neither implies the other: embedding on the
   * operator's key spends money the allowance already refused, and recording a
   * workspace-funded sync against the operator's counter bills them for money
   * they did not spend.
   */
  describe("when the owner is out but their workspace has a key", () => {
    const outOfAllowance = (fake: ReturnType<typeof fakeDb>) => ({
      ...deps(fake),
      entitlements: {
        ...unlimited,
        check: vi.fn(async () => ({
          allowed: false as const,
          used: 100_000,
          limit: 100_000,
          resetsAt: "2026-10-01T00:00:00Z",
        })),
      },
    });

    it("imports on the workspace's key rather than skipping", async () => {
      fakeProvider.listFiles.mockResolvedValue([file("page-1")]);
      fakeProvider.readFile.mockResolvedValue("Twenty days of leave a year.");
      readWorkspaceKeys.mockResolvedValue({ openai: "ws-openai", anthropic: null });
      const fake = db({ activeWorkspace: "ws-1" });
      const withQuota = outOfAllowance(fake);

      const outcome = await runConnection(await connection(), withQuota);

      expect(outcome).toMatchObject({ status: "ok", added: 1 });
      // The env the embedding call was actually made with. `deps.env` here
      // would be the operator paying for a sync their allowance refused.
      expect(vi.mocked(embedTexts).mock.calls[0][0]).toMatchObject({
        OPENAI_API_KEY: "ws-openai",
      });
    });

    it("writes nothing to the operator's counter for what the workspace paid", async () => {
      fakeProvider.listFiles.mockResolvedValue([file("page-1")]);
      fakeProvider.readFile.mockResolvedValue("Twenty days of leave a year.");
      readWorkspaceKeys.mockResolvedValue({ openai: "ws-openai", anthropic: null });
      const fake = db({ activeWorkspace: "ws-1" });
      const withQuota = outOfAllowance(fake);

      await runConnection(await connection(), withQuota);

      expect(withQuota.entitlements.record).not.toHaveBeenCalled();
    });

    it("skips when the workspace has no key of its own", async () => {
      // The control. Same denied verdict, same lookup, nothing found — and the
      // sync is skipped rather than quietly funded by the operator.
      fakeProvider.listFiles.mockResolvedValue([file("page-1")]);
      const fake = db({ activeWorkspace: "ws-1" });

      const outcome = await runConnection(await connection(), outOfAllowance(fake));

      expect(outcome.status).toBe("skipped");
      expect(fakeProvider.listFiles).not.toHaveBeenCalled();
    });
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
