import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memoryDb, type Row } from "../../../test-support/memory-db";
import { encryptSecret } from "../../secret-box";
import type { AdapterContext, SubscriptionRow } from "./adapter";
import { CATALOGUE } from "./catalog";
import { EventSourceError } from "./errors";
import { NOTION_EVENTS, botsOf, notionAdapter, notionIdOf } from "./notion";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ENV = {
  ROUTINE_SECRET_KEY: KEY,
  NOTION_CLIENT_ID: "id",
  NOTION_CLIENT_SECRET: "secret",
  NOTION_WEBHOOK_VERIFICATION_TOKEN: "secret_token",
} as never;

const PAGE_ID = "1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6";
const DB_ID = "0ef104cd477e80e18571cfd10e92339a";
const BOT = "11111111-2222-3333-4444-555555555555";

async function connection(over: Row = {}): Promise<Row> {
  return {
    id: "conn-1",
    workspace_id: "w1",
    user_id: "u1",
    provider: "notion",
    status: "active",
    config: {},
    secret_ciphertext: await encryptSecret(JSON.stringify({ accessToken: "ntn_token" }), KEY),
    ...over,
  };
}

function ctx(type: string, over: Partial<SubscriptionRow> = {}): AdapterContext {
  const def = CATALOGUE.eventType(type);
  if (!def) throw new Error(type);
  return {
    env: ENV,
    routine: { id: "r1", user_id: "u1", workspace_id: "w1" },
    subscription: {
      routine_id: "r1",
      provider: "notion",
      event_type: type,
      config: { connectionId: "conn-1" },
      external_id: BOT,
      secret_ciphertext: null,
      state: { botId: BOT },
      status: "active",
      status_detail: null,
      expires_at: null,
      attempts: 0,
      ...over,
    },
    eventType: def,
    secret: null,
  };
}

/** A Notion API that answers by path, and remembers what it was asked. */
function notionApi(routes: Record<string, unknown>) {
  const asked: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname.replace("/v1", "") + new URL(String(url)).search;
    asked.push(path);
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (!key) return new Response("{}", { status: 404 });
    const answer = routes[key];
    return answer instanceof Response ? answer : Response.json(answer);
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}

async function adapterWith(routes: Record<string, unknown>, conn?: Row) {
  const m = memoryDb({ connections: [conn ?? (await connection())] });
  const api = notionApi(routes);
  return {
    api,
    adapter: notionAdapter({
      db: () => m.db as unknown as SupabaseClient,
      fetchImpl: api.fetchImpl,
    }),
  };
}

const PAGE = {
  object: "page",
  id: PAGE_ID,
  url: `https://www.notion.so/Launch-${PAGE_ID}`,
  parent: { type: "database_id", database_id: "0ef104cd-477e-80e1-8571-cfd10e92339a" },
  properties: { Name: { type: "title", title: [{ plain_text: "Launch checklist" }] } },
};

const BLOCKS = {
  results: [
    {
      type: "paragraph",
      has_children: false,
      paragraph: { rich_text: [{ plain_text: "Book the venue", annotations: {} }] },
    },
  ],
  has_more: false,
};

function delivery(type: string, over: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    timestamp: "2026-10-16T09:00:00.000Z",
    workspace_id: "ws-1",
    type,
    authors: [{ id: "person-1", type: "person" }],
    accessible_by: [
      { id: BOT, type: "bot" },
      { id: "person-1", type: "person" },
    ],
    entity: { id: PAGE_ID, type: "page" },
    data: { parent: { id: DB_ID, type: "database" } },
    ...over,
  };
}

describe("notionIdOf", () => {
  it("reads an id from a link, a dashed id or a bare one, ignoring a view", () => {
    expect(notionIdOf(`https://www.notion.so/acme/Tasks-${DB_ID}?v=${PAGE_ID}`)).toBe(DB_ID);
    expect(notionIdOf("0ef104cd-477e-80e1-8571-cfd10e92339a")).toBe(DB_ID);
    expect(notionIdOf(DB_ID.toUpperCase())).toBe(DB_ID);
    expect(notionIdOf("not an id")).toBeNull();
    expect(notionIdOf("")).toBeNull();
  });
});

describe("botsOf", () => {
  it("lists the bots that can see the page, and nothing else", () => {
    expect(botsOf(delivery("page.created"))).toEqual([BOT]);
    expect(botsOf({ accessible_by: [{ id: "x; drop", type: "bot" }] })).toEqual([]);
    expect(botsOf({})).toEqual([]);
  });
});

describe("the Notion entries", () => {
  it("need a Notion connection and are offered only once the webhook token is set", () => {
    for (const spec of NOTION_EVENTS) {
      expect(spec.def.requires).toEqual({ kind: "connection", provider: "notion" });
    }
    const adapter = notionAdapter();
    expect(adapter.isConfigured(ENV)).toBe(true);
    expect(
      adapter.isConfigured({ ...(ENV as object), NOTION_WEBHOOK_VERIFICATION_TOKEN: "" } as never),
    ).toBe(false);
  });

  it("filter new pages by database, and the rest by page or database", () => {
    const created = CATALOGUE.eventType("notion.page_created")!;
    const edited = CATALOGUE.eventType("notion.page_edited")!;
    const at = { eventId: "e", text: "", fields: { pageId: PAGE_ID, databaseId: DB_ID } };
    expect(created.matches!({}, at)).toBe(true);
    expect(created.matches!({ database: `https://www.notion.so/${DB_ID}` }, at)).toBe(true);
    expect(created.matches!({ database: PAGE_ID }, at)).toBe(false);
    expect(edited.matches!({ page: PAGE_ID }, at)).toBe(true);
    expect(edited.matches!({ page: DB_ID }, at)).toBe(true);
    expect(edited.matches!({ page: "f".repeat(32) }, at)).toBe(false);
  });
});

describe("notionAdapter.subscribe", () => {
  it("records the connection's bot as what deliveries are matched by", async () => {
    const { adapter, api } = await adapterWith({ "/users/me": { id: BOT, type: "bot" } });
    expect(await adapter.subscribe(ctx("notion.page_created"))).toEqual({
      externalId: BOT,
      state: { botId: BOT },
    });
    expect(api.asked).toEqual(["/users/me"]);
  });

  it("calls a removed, paused or foreign connection expired", async () => {
    for (const over of [
      { status: "paused" },
      { workspace_id: "other" },
      { provider: "google_drive" },
    ]) {
      const { adapter } = await adapterWith({}, await connection(over));
      const err = await adapter.subscribe(ctx("notion.page_created")).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EventSourceError);
      expect((err as EventSourceError).expired).toBe(true);
    }
  });

  it("calls Notion refusing the token expired too", async () => {
    const { adapter } = await adapterWith({ "/users/me": new Response("no", { status: 401 }) });
    await expect(adapter.subscribe(ctx("notion.page_created"))).rejects.toThrow(/refused/);
  });
});

describe("notionAdapter.normalize", () => {
  it("reads a new page's title, link, database and text with the connection's token", async () => {
    const { adapter } = await adapterWith({
      [`/pages/${PAGE_ID}`]: PAGE,
      [`/blocks/${PAGE_ID}/children`]: BLOCKS,
    });
    const event = await adapter.normalize(delivery("page.created"), ctx("notion.page_created"));
    expect(event).toMatchObject({
      eventId: "notion:evt-1",
      label: "Notion · New page: Launch checklist",
      fields: { pageId: PAGE_ID, databaseId: DB_ID },
    });
    expect(event?.text).toContain("Page: Launch checklist");
    expect(event?.text).toContain("What happened: Created");
    expect(event?.text).toContain("Book the venue");
  });

  it("reads a comment's text", async () => {
    const { adapter } = await adapterWith({
      [`/pages/${PAGE_ID}`]: PAGE,
      "/comments": { results: [{ id: "c-1", rich_text: [{ plain_text: "Tuesday instead?" }] }] },
    });
    const event = await adapter.normalize(
      delivery("comment.created", {
        entity: { id: "c-1", type: "comment" },
        data: { page_id: PAGE_ID, parent: { id: PAGE_ID, type: "page" } },
      }),
      ctx("notion.comment_added"),
    );
    expect(event?.text).toContain("Comment: Tuesday instead?");
    expect(event?.fields?.pageId).toBe(PAGE_ID);
  });

  it("runs nothing for another kind of event, or a change only integrations made", async () => {
    const { adapter, api } = await adapterWith({});
    expect(
      await adapter.normalize(delivery("page.content_updated"), ctx("notion.page_created")),
    ).toBeNull();
    expect(
      await adapter.normalize(
        delivery("page.created", { authors: [{ id: "bot-9", type: "bot" }] }),
        ctx("notion.page_created"),
      ),
    ).toBeNull();
    expect(api.asked).toEqual([]);
  });

  it("still says what happened about a page the connection cannot open", async () => {
    const { adapter } = await adapterWith({});
    const event = await adapter.normalize(delivery("page.created"), ctx("notion.page_created"));
    expect(event?.text).toContain("a page this connection cannot open");
    expect(event?.fields?.databaseId).toBe(DB_ID);
  });
});
