/**
 * Notion: a page created (or a new item in a database), a page edited, a
 * page's properties changed, a comment added.
 *
 * ONE WEBHOOK FOR EVERY WORKSPACE. A public Notion integration has one webhook
 * subscription, set up once in its settings and pointed at
 * `POST /notion/events`; Notion delivers there for every workspace the
 * integration is installed in. So nothing is subscribed per routine at Notion.
 * What a routine "subscribes" to is its own connection's bot: each OAuth grant
 * of a public integration is a bot user of its own, and a delivery's
 * `accessible_by` names the bots that can see the page it is about. The bot's
 * id is this subscription's `external_id`, and the route offers a delivery to
 * every subscription holding one of the bots it names (`notion-events.ts`).
 * That is also the whole of the access check: a routine hears about a page
 * only when the connection it was set up with can read that page.
 *
 * WHAT IS READ. A delivery names the page and little else — no title, no
 * text — so the page is fetched with the connection's own token, and its
 * content read the way the connection's sync reads it
 * (`lib/connections/notion.ts`). The model reads the title, the link, what
 * happened, and the page itself, cut to a length.
 *
 * WHAT DOES NOT RUN ANYTHING. A change made only by integrations — a bot or
 * an agent among the authors and no person — is left out. A routine that
 * writes its findings into Notion would otherwise start itself again with
 * every page it wrote.
 *
 * TIMING. Notion batches edits: a page being typed into produces one
 * `page.content_updated` a minute or two after the typing stops, not one per
 * keystroke. Comments and new pages arrive within seconds.
 */

import { z } from "zod";
import type { RoutineEnv } from "../../../types";
import { textOf, type ProviderEnv } from "../../connections/types";
import {
  NOTION_API,
  NOTION_VERSION,
  notionProvider,
  plainText,
  titleOf,
  type NotionPage,
} from "../../connections/notion";
import type { AdapterContext, EventAdapter, SubscribeResult } from "./adapter";
import type { EventTypeDef, NormalizedEvent } from "./catalog";
import { grantFor, type GrantDeps } from "./connection-grant";
import { EventSourceError } from "./errors";
import { clip, lines, rec, str } from "./text";

/** A Notion page or database id from a link or an id, as 32 lowercase hex digits. */
export function notionIdOf(input: unknown): string | null {
  const value = str(input);
  if (!value) return null;
  // A link's id is the last 32 hex digits of its path — `?v=` after it names
  // a view of a database, not the database.
  let path = value;
  try {
    if (value.includes("://")) path = new URL(value).pathname;
  } catch {
    // Not a URL; read it as an id.
  }
  const compact = path.replace(/-/g, "").toLowerCase();
  const all = compact.match(/[0-9a-f]{32}/g);
  return all ? all[all.length - 1] : null;
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

/**
 * "Only in this page or database": the event's page itself, or the database
 * it is an item of. Empty means anything the connection can see.
 */
function within(config: Record<string, unknown>, event: NormalizedEvent): boolean {
  const wanted = notionIdOf(config.page);
  if (!wanted) return true;
  return event.fields?.pageId === wanted || event.fields?.databaseId === wanted;
}

const PAGE_FIELD = {
  key: "page",
  label: "Only in",
  kind: "text" as const,
  optional: true,
  placeholder: "A page or database link",
  help: "A page, or a database whose items count. Empty means any page your Notion connection can see.",
};

const REQUIRES = { kind: "connection", provider: "notion" } as const;

export type NotionEventSpec = {
  def: EventTypeDef;
  /** The webhook event type this entry is for. */
  notionType: string;
  /** What happened, in the words the model reads. */
  happened: string;
};

const SAMPLE_PAGE = lines([
  ["Page", "Q4 launch checklist"],
  ["Link", "https://www.notion.so/Q4-launch-checklist-1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6"],
]);

export const NOTION_EVENTS: readonly NotionEventSpec[] = [
  {
    notionType: "page.created",
    happened: "Created",
    def: {
      id: "notion.page_created",
      provider: "notion",
      app: "Notion",
      label: "New page",
      description:
        "Runs shortly after a page is created — or, with a database chosen, an item is added to it.",
      requires: REQUIRES,
      config: z.object({ database: optionalText(500) }),
      fields: [
        {
          key: "database",
          label: "Only new items in",
          kind: "text",
          optional: true,
          placeholder: "A database link",
          help: "Paste a Notion database's link. Empty means any new page your Notion connection can see.",
        },
      ],
      matches: (config, event) => {
        const wanted = notionIdOf(config.database);
        return !wanted || event.fields?.databaseId === wanted;
      },
      sample: {
        eventId: "sample",
        text: `${SAMPLE_PAGE}\nWhat happened: Created\n\n# Q4 launch checklist\n\n- [ ] Press kit\n- [ ] Pricing page`,
        fields: { pageId: "1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6", databaseId: "" },
      },
    },
  },
  {
    notionType: "page.content_updated",
    happened: "Edited",
    def: {
      id: "notion.page_edited",
      provider: "notion",
      app: "Notion",
      label: "Page edited",
      description: "Runs a minute or two after somebody edits a page's content.",
      requires: REQUIRES,
      config: z.object({ page: optionalText(500) }),
      fields: [PAGE_FIELD],
      matches: within,
      sample: {
        eventId: "sample",
        text: `${SAMPLE_PAGE}\nWhat happened: Edited\n\n# Q4 launch checklist\n\n- [x] Press kit\n- [ ] Pricing page`,
        fields: { pageId: "1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6", databaseId: "" },
      },
    },
  },
  {
    notionType: "page.properties_updated",
    happened: "Properties changed",
    def: {
      id: "notion.properties_changed",
      provider: "notion",
      app: "Notion",
      label: "Properties changed",
      description:
        "Runs when a page's properties change — a database item's status, owner or date.",
      requires: REQUIRES,
      config: z.object({ page: optionalText(500) }),
      fields: [PAGE_FIELD],
      matches: within,
      sample: {
        eventId: "sample",
        text: `${SAMPLE_PAGE}\nWhat happened: Properties changed\n\n- **Status:** In review\n- **Owner:** Ayşe Demir`,
        fields: { pageId: "1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6", databaseId: "" },
      },
    },
  },
  {
    notionType: "comment.created",
    happened: "New comment",
    def: {
      id: "notion.comment_added",
      provider: "notion",
      app: "Notion",
      label: "New comment",
      description: "Runs within seconds of a comment being added to a page.",
      requires: REQUIRES,
      config: z.object({ page: optionalText(500) }),
      fields: [PAGE_FIELD],
      matches: within,
      sample: {
        eventId: "sample",
        text: `${SAMPLE_PAGE}\nWhat happened: New comment\n\nComment: Can we move the press kit to Tuesday?`,
        fields: { pageId: "1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6", databaseId: "" },
      },
    },
  },
];

function notionSpec(type: string): NotionEventSpec | undefined {
  return NOTION_EVENTS.find((s) => s.def.id === type);
}

/** The bot ids a delivery says can see its page — the route's fan-out list. */
export function botsOf(delivery: unknown): string[] {
  const list = rec(delivery)?.accessible_by;
  if (!Array.isArray(list)) return [];
  return list
    .map(rec)
    .filter((r) => r !== null && r.type === "bot")
    .map((r) => str(r!.id))
    .filter((id) => /^[0-9a-f-]{32,36}$/i.test(id));
}

/** Whether only integrations made this change — see the module comment. */
function madeByIntegrations(delivery: Record<string, unknown>): boolean {
  const authors = Array.isArray(delivery.authors) ? delivery.authors.map(rec) : [];
  if (authors.length === 0) return false;
  return authors.every((a) => a !== null && (a.type === "bot" || a.type === "agent"));
}

// ---- the adapter -------------------------------------------------------------------

export type NotionAdapterDeps = GrantDeps & { fetchImpl?: typeof fetch };

export function notionAdapter(deps: NotionAdapterDeps = {}): EventAdapter {
  const fetchImpl: typeof fetch = deps.fetchImpl ?? fetch.bind(globalThis);

  async function call(token: string, path: string): Promise<Response> {
    return fetchImpl(`${NOTION_API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION },
      signal: AbortSignal.timeout(10_000),
    });
  }

  /** The page, or null when the connection cannot read it (not shared, deleted). */
  async function pageOf(token: string, pageId: string): Promise<NotionPage | null> {
    const res = await call(token, `/pages/${pageId}`);
    if (!res.ok) return null;
    return (await res.json()) as NotionPage;
  }

  /** A comment's text, found among its parent's comments. "" when it cannot be. */
  async function commentText(token: string, parentId: string, commentId: string): Promise<string> {
    const res = await call(token, `/comments?block_id=${parentId}&page_size=100`);
    if (!res.ok) return "";
    const body = rec(await res.json());
    const found = (Array.isArray(body?.results) ? body.results.map(rec) : []).find(
      (c) => c !== null && str(c.id) === commentId,
    );
    return found ? plainText(found.rich_text).trim() : "";
  }

  return {
    provider: "notion",

    isConfigured(env: RoutineEnv) {
      const oauth = env as RoutineEnv & ProviderEnv;
      return Boolean(
        oauth.NOTION_CLIENT_ID &&
        oauth.NOTION_CLIENT_SECRET &&
        env.NOTION_WEBHOOK_VERIFICATION_TOKEN,
      );
    },

    // The connection's bot: who Notion says can see a page. Asked of Notion
    // rather than stored at connect time, because connections made before this
    // existed never stored it.
    async subscribe(ctx): Promise<SubscribeResult> {
      const grant = await grantFor(ctx, "notion", deps);
      const res = await call(grant.token.accessToken, "/users/me");
      if (res.status === 401 || res.status === 403) {
        throw new EventSourceError(
          "Notion refused the connection. Connect Notion again, then choose this event again.",
          { expired: true },
        );
      }
      if (!res.ok) throw new Error(`notion users/me answered ${res.status}`);
      const botId = str(rec(await res.json())?.id);
      if (!botId) throw new Error("notion users/me returned no id");
      return { externalId: botId, state: { botId } };
    },

    // Nothing at Notion is per routine: the webhook is the integration's.
    async unsubscribe() {},
    async setEnabled() {},

    async normalize(raw, ctx: AdapterContext) {
      const spec = notionSpec(ctx.subscription.event_type);
      const delivery = rec(raw);
      if (!spec || !delivery || str(delivery.type) !== spec.notionType) return null;
      if (madeByIntegrations(delivery)) return null;

      const data = rec(delivery.data) ?? {};
      const entityId = str(rec(delivery.entity)?.id);
      const pageId = spec.notionType === "comment.created" ? str(data.page_id) : entityId;
      if (!pageId) return null;

      const grant = await grantFor(ctx, "notion", deps);
      const token = grant.token.accessToken;
      const page = await pageOf(token, pageId);

      // Which database it is an item of, if any. The page's own parent, read
      // at the API version the sync uses, names the database even when the
      // webhook was set up at a version that names a data source instead.
      const pageParent = rec(page?.parent);
      const deliveredParent = rec(data.parent);
      const databaseId =
        notionIdOf(pageParent?.database_id) ??
        (["database", "data_source"].includes(str(deliveredParent?.type))
          ? notionIdOf(deliveredParent?.id)
          : null) ??
        "";

      const title = page ? titleOf(page) : "";
      const header = lines([
        ["Page", title || "(a page this connection cannot open)"],
        ["Link", str(page?.url)],
        ["What happened", spec.happened],
        ["When", str(delivery.timestamp)],
      ]);

      let body = "";
      if (spec.notionType === "comment.created") {
        const text = await commentText(token, str(deliveredParent?.id) || pageId, entityId);
        body = text ? `Comment: ${text}` : "";
      } else if (page) {
        try {
          body = textOf(
            await notionProvider.readFile(
              { token: grant.token, config: grant.config, fetchImpl },
              {
                externalId: pageId,
                name: title,
                version: "",
                url: str(page.url) || null,
                listing: page,
              },
            ),
          );
        } catch (err) {
          console.error(`notion event: could not read page ${pageId}`, err);
        }
      }

      return {
        eventId: `notion:${str(delivery.id) || `${spec.notionType}:${entityId}:${str(delivery.timestamp)}`}`,
        text: body ? `${header}\n\n${clip(body)}` : header,
        label: title ? `Notion · ${spec.def.label}: ${title}`.slice(0, 120) : undefined,
        fields: { pageId: notionIdOf(pageId) ?? "", databaseId },
      };
    },
  };
}

export const NOTION_ADAPTER = notionAdapter();
