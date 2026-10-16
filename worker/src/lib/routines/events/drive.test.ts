import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memoryDb, type Row } from "../../../test-support/memory-db";
import { encryptSecret } from "../../secret-box";
import type { AdapterContext, SubscriptionRow } from "./adapter";
import { CATALOGUE } from "./catalog";
import { EventSourceError } from "./errors";
import { DRIVE_CHANNEL_ID, DRIVE_EVENTS, driveAdapter, driveFolderIdOf } from "./drive";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ENV = {
  ROUTINE_SECRET_KEY: KEY,
  GOOGLE_CLIENT_ID: "id",
  GOOGLE_CLIENT_SECRET: "secret",
  WORKER_HOST: "api.example.com",
} as never;
const NOW = Date.parse("2026-10-16T12:00:00Z");
const FOLDER = "1FolderAbCdEfGhIjKlMn";

async function connection(over: Row = {}): Promise<Row> {
  return {
    id: "conn-1",
    workspace_id: "w1",
    user_id: "u1",
    provider: "google_drive",
    status: "active",
    config: { folderId: FOLDER },
    // Unexpired, so `refresh` hands it back without asking Google.
    secret_ciphertext: await encryptSecret(
      JSON.stringify({ accessToken: "ya29", refreshToken: "1//r", expiresAt: NOW + 3_600_000 }),
      KEY,
    ),
    ...over,
  };
}

function ctx(type: string, over: Partial<SubscriptionRow> = {}, secret: string | null = null) {
  const def = CATALOGUE.eventType(type);
  if (!def) throw new Error(type);
  return {
    env: ENV,
    routine: { id: "r1", user_id: "u1", workspace_id: "w1" },
    subscription: {
      routine_id: "r1",
      provider: "google_drive",
      event_type: type,
      config: { connectionId: "conn-1" },
      external_id: null,
      secret_ciphertext: null,
      state: {},
      status: "pending",
      status_detail: null,
      expires_at: null,
      attempts: 0,
      ...over,
    },
    eventType: def,
    secret,
  } satisfies AdapterContext;
}

/** Drive, answering by method and path, remembering each call. */
function driveApi(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  const calls: { key: string; url: URL; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname.replace("/drive/v3", "")}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ key, url, body });
    const answer = routes[key];
    if (answer === undefined) return new Response("{}", { status: 404 });
    const value = typeof answer === "function" ? (answer as (b: unknown) => unknown)(body) : answer;
    return value instanceof Response ? value : Response.json(value);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function adapterWith(routes: Parameters<typeof driveApi>[0], conn?: Row) {
  const m = memoryDb({ connections: [conn ?? (await connection())] });
  const api = driveApi(routes);
  return {
    api,
    adapter: driveAdapter({
      db: () => m.db as unknown as SupabaseClient,
      fetchImpl: api.fetchImpl,
      now: () => NOW,
    }),
  };
}

const change = (over: Record<string, unknown> = {}, file: Record<string, unknown> = {}) => ({
  fileId: "f1",
  time: "2026-10-16T11:59:00.000Z",
  removed: false,
  file: {
    id: "f1",
    name: "Contract.docx",
    mimeType: "application/pdf",
    parents: [FOLDER],
    createdTime: "2026-10-16T11:58:30.000Z",
    modifiedTime: "2026-10-16T11:59:00.000Z",
    webViewLink: "https://drive.google.com/file/d/f1/view",
    lastModifyingUser: { displayName: "Mert", emailAddress: "mert@example.com" },
    ...file,
  },
  ...over,
});

describe("driveFolderIdOf", () => {
  it("reads a folder id from its link or as it is", () => {
    expect(driveFolderIdOf(`https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`)).toBe(
      FOLDER,
    );
    expect(driveFolderIdOf(FOLDER)).toBe(FOLDER);
    expect(driveFolderIdOf("a b")).toBeNull();
  });
});

describe("the Drive entries", () => {
  it("need a Drive connection, and a public address for Drive to call", () => {
    for (const spec of DRIVE_EVENTS) {
      expect(spec.def.requires).toEqual({ kind: "connection", provider: "google_drive" });
    }
    expect(driveAdapter().isConfigured(ENV)).toBe(true);
    expect(driveAdapter().isConfigured({ ...(ENV as object), WORKER_HOST: "" } as never)).toBe(
      false,
    );
  });
});

describe("driveAdapter channels", () => {
  it("opens a week-long channel from a fresh page token, with a secret of its own", async () => {
    const { adapter, api } = await adapterWith({
      "GET /changes/startPageToken": { startPageToken: "100" },
      "POST /changes/watch": { resourceId: "res-1", expiration: String(NOW + 600_000_000) },
    });
    const result = await adapter.subscribe(ctx("google_drive.new_file"));

    expect(result.externalId).toMatch(DRIVE_CHANNEL_ID);
    expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.state).toEqual({ pageToken: "100", resourceId: "res-1" });
    expect(result.expiresAt).toEqual(new Date(NOW + 600_000_000));
    const watch = api.calls.find((c) => c.key === "POST /changes/watch")!;
    expect(watch.url.searchParams.get("pageToken")).toBe("100");
    expect(watch.body).toMatchObject({
      id: result.externalId,
      type: "web_hook",
      address: `https://api.example.com/routine-events/drive/${result.externalId}`,
      token: result.secret,
    });
  });

  it("renews with a new channel from the same page token, then stops the old one", async () => {
    const { adapter, api } = await adapterWith({
      "POST /changes/watch": { resourceId: "res-2" },
      "POST /channels/stop": new Response(null, { status: 204 }),
    });
    const old = "dr_" + "a".repeat(32);
    const next = await adapter.renew!(
      ctx(
        "google_drive.new_file",
        { external_id: old, state: { pageToken: "150", resourceId: "res-1" }, status: "active" },
        "kept",
      ),
    );
    expect(next.externalId).not.toBe(old);
    expect(next).toMatchObject({
      secret: "kept",
      state: { pageToken: "150", resourceId: "res-2" },
    });
    expect(api.calls.map((c) => c.key)).toEqual(["POST /changes/watch", "POST /channels/stop"]);
    expect(api.calls[1].body).toEqual({ id: old, resourceId: "res-1" });
  });

  it("stops the channel on pause, and resumes from now rather than from where it stopped", async () => {
    const { adapter, api } = await adapterWith({
      "POST /channels/stop": new Response(null, { status: 204 }),
      "GET /changes/startPageToken": { startPageToken: "900" },
      "POST /changes/watch": { resourceId: "res-3" },
    });
    const paused = ctx(
      "google_drive.file_changed",
      { external_id: "dr_" + "b".repeat(32), state: { pageToken: "150", resourceId: "res-1" } },
      "kept",
    );
    await adapter.setEnabled(paused, false);
    const resumed = await adapter.setEnabled(paused, true);
    expect(api.calls[0].key).toBe("POST /channels/stop");
    expect(resumed).toMatchObject({ state: { pageToken: "900" }, secret: "kept" });
  });

  it("calls Drive refusing the grant expired", async () => {
    const { adapter } = await adapterWith({
      "GET /changes/startPageToken": new Response("no", { status: 401 }),
    });
    const err = await adapter.subscribe(ctx("google_drive.new_file")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EventSourceError);
    expect((err as EventSourceError).expired).toBe(true);
  });

  it("accepts only the channel's own token back", async () => {
    const adapter = driveAdapter();
    const c = ctx("google_drive.new_file", {}, "kept");
    expect(await adapter.authenticate!({ token: "kept", state: "change" }, c)).toBe(true);
    expect(await adapter.authenticate!({ token: "other", state: "change" }, c)).toBe(false);
    expect(
      await adapter.authenticate!({ token: "", state: "change" }, ctx("google_drive.new_file")),
    ).toBe(false);
  });
});

describe("driveAdapter.advance", () => {
  it("lists what changed since the page token and hands back where to read from next", async () => {
    const { adapter, api } = await adapterWith({
      "GET /changes": { changes: [change()], newStartPageToken: "201" },
    });
    const advanced = await adapter.advance!(
      { token: "kept", state: "change" },
      ctx("google_drive.new_file", { state: { pageToken: "200", resourceId: "res-1" } }),
    );
    expect(advanced).toEqual({
      raw: { changes: [change()], connectionFolder: FOLDER },
      state: { pageToken: "201", resourceId: "res-1" },
      cursor: { key: "pageToken", from: "200" },
    });
    expect(api.calls[0].url.searchParams.get("pageToken")).toBe("200");
  });

  it("follows the pages of a long list", async () => {
    let n = 0;
    const { adapter } = await adapterWith({
      "GET /changes": () =>
        ++n === 1
          ? { changes: [change()], nextPageToken: "p2" }
          : { changes: [], newStartPageToken: "300" },
    });
    const advanced = await adapter.advance!(
      { token: "kept", state: "change" },
      ctx("google_drive.new_file", { state: { pageToken: "200" } }),
    );
    expect(advanced?.state).toEqual({ pageToken: "300" });
  });

  it("has nothing to do for the channel's first message, or when nothing changed", async () => {
    const { adapter } = await adapterWith({
      "GET /changes": { changes: [], newStartPageToken: "200" },
    });
    const c = ctx("google_drive.new_file", { state: { pageToken: "200" } });
    expect(await adapter.advance!({ token: "kept", state: "sync" }, c)).toBeNull();
    expect(await adapter.advance!({ token: "kept", state: "change" }, c)).toBeNull();
  });
});

describe("driveAdapter.normalize", () => {
  const adapter = driveAdapter({ now: () => NOW });

  it("tells a new file from a changed one", async () => {
    const created = await adapter.normalize(
      { changes: [change()], connectionFolder: FOLDER },
      ctx("google_drive.new_file"),
    );
    expect(created?.text).toContain("File: Contract.docx");
    expect(created?.text).toContain("By: Mert <mert@example.com>");
    expect(created?.label).toBe("Google Drive · Added: Contract.docx");
    expect(
      await adapter.normalize(
        { changes: [change()], connectionFolder: FOLDER },
        ctx("google_drive.file_changed"),
      ),
    ).toBeNull();

    const edited = change({}, { createdTime: "2026-01-01T00:00:00.000Z" });
    expect(
      await adapter.normalize(
        { changes: [edited], connectionFolder: FOLDER },
        ctx("google_drive.file_changed"),
      ),
    ).not.toBeNull();
  });

  it("leaves out folders, the trashed, the removed, and files outside the folder", async () => {
    const changes = [
      change({}, { mimeType: "application/vnd.google-apps.folder" }),
      change({}, { id: "f2", trashed: true }),
      change({ removed: true }),
      change({}, { id: "f3", parents: ["elsewhere"] }),
    ];
    expect(
      await adapter.normalize({ changes, connectionFolder: FOLDER }, ctx("google_drive.new_file")),
    ).toBeNull();
  });

  it("uses the routine's own folder over the connection's", async () => {
    const elsewhere = change({}, { parents: ["OtherFolder123456"] });
    const c = ctx("google_drive.new_file", {
      config: {
        connectionId: "conn-1",
        folder: "https://drive.google.com/drive/folders/OtherFolder123456",
      },
    });
    expect(
      await adapter.normalize({ changes: [elsewhere], connectionFolder: FOLDER }, c),
    ).not.toBeNull();
  });

  it("names the same set of changes the same way, so a repeat runs once", async () => {
    const a = await adapter.normalize(
      { changes: [change()], connectionFolder: FOLDER },
      ctx("google_drive.new_file"),
    );
    const b = await adapter.normalize(
      { changes: [change()], connectionFolder: FOLDER },
      ctx("google_drive.new_file"),
    );
    expect(a?.eventId).toMatch(/^drive:[0-9a-f]{32}$/);
    expect(a?.eventId).toBe(b?.eventId);
  });

  it("reads a single Google Doc's text", async () => {
    const { adapter: reading } = await adapterWith({
      "GET /files/f1": {
        id: "f1",
        name: "Notes",
        mimeType: "application/vnd.google-apps.document",
      },
      "GET /files/f1/export": new Response("# Notes\n\nShip on Friday."),
    });
    const doc = change({}, { name: "Notes", mimeType: "application/vnd.google-apps.document" });
    const event = await reading.normalize(
      { changes: [doc], connectionFolder: FOLDER },
      ctx("google_drive.new_file"),
    );
    expect(event?.text).toContain("Ship on Friday.");
  });
});
