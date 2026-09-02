import {
  errorForStatus,
  ProviderError,
  type ConnectionProvider,
  type ProviderContext,
  type ProviderEnv,
  type RemoteFile,
} from "./types";

/**
 * Notion, as a source of documents.
 *
 * The scope is chosen by Notion rather than by us, and that is the nicest thing
 * about this provider: during the grant, Notion shows its own page picker, and
 * the integration can afterwards see exactly what was ticked there and nothing
 * else. So there is no folder to configure on our side, no "which pages?"
 * screen to build, and — the part that matters — no way for our interface to
 * imply access we do not have. `search` returns the picked pages; a page
 * un-picked later simply stops appearing, and the reconciler removes it.
 */

/**
 * The pinned API version. Notion sends it as a header on every request and
 * treats a missing one as an error, so this is not optional politeness.
 *
 * Pinned rather than tracked: Notion's versions are dated and old ones keep
 * working, so the cost of being behind is missing features we do not use, while
 * the cost of following along is a block shape changing under a sync nobody is
 * watching.
 */
const NOTION_VERSION = "2022-06-28";

const API = "https://api.notion.com/v1";

/**
 * How many pages of blocks one document may cost.
 *
 * A Notion page is read 100 blocks at a time, and a sync runs on a Worker with
 * a subrequest budget shared by every document in the run (see `sync.ts`). Three
 * pages is 300 blocks — comfortably the whole of any handbook page anybody
 * actually writes — and the cap means one pathological document cannot starve
 * the four others in the same run.
 */
const MAX_BLOCK_PAGES = 3;

/**
 * How deep nested blocks are followed.
 *
 * Toggles inside toggles inside toggles are a way of writing, and each level is
 * another request per parent block. Two levels keeps ordinary nesting — a list
 * under a heading, a paragraph inside a toggle — and stops before the shape
 * where reading one page costs fifty requests.
 */
const MAX_BLOCK_DEPTH = 2;

/** How many results one `search` page returns. Notion's maximum is 100. */
const SEARCH_PAGE_SIZE = 100;

/**
 * How many `search` pages one listing may cost.
 *
 * 500 pages is far more than the ICP has, and a connection that hits this
 * ceiling syncs the first 500 rather than failing — which is the right failure
 * for a bundle that is meant to be curated anyway. `sync.ts` reports the cap so
 * it is visible rather than silent.
 */
const MAX_SEARCH_PAGES = 5;

type NotionRichText = { plain_text?: string };
type NotionBlock = {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
};
type NotionPage = {
  id: string;
  object: string;
  url?: string;
  last_edited_time?: string;
  in_trash?: boolean;
  archived?: boolean;
  properties?: Record<string, { type?: string; title?: NotionRichText[] }>;
};

function authHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function notionFetch(
  ctx: ProviderContext,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const res = await ctx.fetchImpl(`${API}${path}`, {
    ...init,
    headers: { ...authHeaders(ctx.token.accessToken), ...(init.headers ?? {}) },
  });
  if (!res.ok) throw errorForStatus("Notion", res.status, await res.text().catch(() => ""));
  return res.json();
}

/** The concatenated plain text of a rich-text array, or "". */
function richText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((r) => (r && typeof r === "object" ? ((r as NotionRichText).plain_text ?? "") : ""))
    .join("");
}

/**
 * A page's title.
 *
 * The title property is not called "title" on a database row — it is called
 * whatever the person named that column — so it is found by `type`, which is
 * the one thing Notion guarantees. An untitled page is a real thing in Notion
 * and gets the name Notion itself shows for it.
 */
function titleOf(page: NotionPage): string {
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop?.type === "title") {
      const text = richText(prop.title).trim();
      if (text) return text;
    }
  }
  return "Untitled";
}

/**
 * One block as a line of Markdown.
 *
 * Markdown rather than bare text because the shape is meaning: a heading tells
 * the chunker where a section starts, and a list that arrives as one run-on
 * paragraph retrieves worse than the same list with its bullets. Block types
 * this does not know about contribute their rich text and lose their styling,
 * which is the correct amount of effort for a block type nobody uses.
 */
function blockToMarkdown(block: NotionBlock): string {
  const body = (block as Record<string, { rich_text?: unknown; [k: string]: unknown }>)[block.type];
  const text = richText(body?.rich_text);

  switch (block.type) {
    case "heading_1":
      return text ? `# ${text}` : "";
    case "heading_2":
      return text ? `## ${text}` : "";
    case "heading_3":
      return text ? `### ${text}` : "";
    case "bulleted_list_item":
      return text ? `- ${text}` : "";
    case "numbered_list_item":
      // Always "1." — Markdown renumbers, and the block itself does not know
      // its own position in the list.
      return text ? `1. ${text}` : "";
    case "to_do": {
      const checked = Boolean((body as { checked?: boolean } | undefined)?.checked);
      return text ? `- [${checked ? "x" : " "}] ${text}` : "";
    }
    case "quote":
      return text ? `> ${text}` : "";
    case "code": {
      const language = (body as { language?: string } | undefined)?.language ?? "";
      return text ? `\`\`\`${language}\n${text}\n\`\`\`` : "";
    }
    case "divider":
      return "---";
    case "table_row": {
      const cells = (body as { cells?: unknown[] } | undefined)?.cells ?? [];
      const rendered = cells.map((cell) => richText(cell).trim());
      return rendered.some(Boolean) ? `| ${rendered.join(" | ")} |` : "";
    }
    // child_page and child_database are deliberately dropped rather than
    // followed: `search` returns them as pages in their own right, so following
    // them here would index the same content twice — once as itself and once
    // inside its parent, where a citation could not link to it.
    case "child_page":
    case "child_database":
      return "";
    default:
      return text;
  }
}

/** Blocks under one parent, flattened to Markdown, following nesting to a depth. */
async function readBlocks(ctx: ProviderContext, parentId: string, depth: number): Promise<string[]> {
  const lines: string[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_BLOCK_PAGES; page++) {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const data = (await notionFetch(ctx, `/blocks/${parentId}/children?${query}`)) as {
      results?: NotionBlock[];
      has_more?: boolean;
      next_cursor?: string | null;
    };

    for (const block of data.results ?? []) {
      const line = blockToMarkdown(block);
      if (line) lines.push(line);
      if (block.has_children && depth < MAX_BLOCK_DEPTH && block.type !== "child_page") {
        const nested = await readBlocks(ctx, block.id, depth + 1);
        // Indented so a nested list stays a nested list once it is Markdown.
        for (const nestedLine of nested) lines.push(`    ${nestedLine}`);
      }
    }

    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  return lines;
}

export const notionProvider: ConnectionProvider = {
  id: "notion",
  label: "Notion",

  isConfigured(env: ProviderEnv): boolean {
    return Boolean(env.NOTION_CLIENT_ID && env.NOTION_CLIENT_SECRET);
  },

  authorizeUrl(env: ProviderEnv, state: string, redirectUri: string): string {
    const url = new URL(`${API}/oauth/authorize`);
    url.searchParams.set("client_id", env.NOTION_CLIENT_ID ?? "");
    url.searchParams.set("response_type", "code");
    // "user" is the only value Notion accepts, and it means the grant belongs
    // to the person clicking rather than to the workspace — which is what makes
    // the page picker theirs to fill in.
    url.searchParams.set("owner", "user");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  },

  async exchangeCode(env, code, redirectUri, fetchImpl) {
    // HTTP Basic with the client id and secret, which is the only form Notion's
    // token endpoint accepts — credentials in the body are rejected.
    const basic = btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`);
    const res = await fetchImpl(`${API}/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) throw errorForStatus("Notion", res.status, await res.text().catch(() => ""));

    const data = (await res.json()) as {
      access_token?: string;
      workspace_name?: string;
    };
    if (!data.access_token) {
      throw new ProviderError("Notion returned no access token", false);
    }

    return {
      // Notion tokens do not expire and there is no refresh token to hold.
      token: { accessToken: data.access_token },
      accountLabel: data.workspace_name?.trim() || "Notion",
      // Nothing to scope: the picker already did it, and re-stating it here
      // would be a copy that goes stale the first time somebody edits the
      // selection in Notion.
      config: {},
    };
  },

  async refresh(_env, token) {
    return token;
  },

  async listFiles(ctx: ProviderContext): Promise<RemoteFile[]> {
    const files: RemoteFile[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
      const body: Record<string, unknown> = {
        page_size: SEARCH_PAGE_SIZE,
        filter: { value: "page", property: "object" },
        // Oldest first, so a listing that hits MAX_SEARCH_PAGES keeps the same
        // 500 pages every run instead of a different 500 each time — a set that
        // churns would have the reconciler delete and re-import forever.
        sort: { direction: "ascending", timestamp: "last_edited_time" },
      };
      if (cursor) body.start_cursor = cursor;

      const data = (await notionFetch(ctx, "/search", {
        method: "POST",
        body: JSON.stringify(body),
      })) as { results?: NotionPage[]; has_more?: boolean; next_cursor?: string | null };

      for (const page of data.results ?? []) {
        if (page.object !== "page") continue;
        // A trashed page is still returned by search for a while. Skipping it
        // here is what makes the reconciler treat it as removed.
        if (page.in_trash || page.archived) continue;
        files.push({
          externalId: page.id,
          name: `${titleOf(page)}.md`,
          version: page.last_edited_time ?? "",
          url: page.url ?? null,
        });
      }

      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }

    return files;
  },

  async readFile(ctx: ProviderContext, file: RemoteFile): Promise<string> {
    const lines = await readBlocks(ctx, file.externalId, 0);
    // The title is prepended as a heading because the body does not contain it
    // — in Notion the title is a property, not the first block — and a chunk
    // that never names its own document retrieves badly for the question that
    // uses the document's name.
    const title = file.name.replace(/\.md$/, "");
    return [`# ${title}`, "", ...lines].join("\n").trim();
  },
};
