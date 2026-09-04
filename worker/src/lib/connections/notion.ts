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

/**
 * How many rows of one table are read.
 *
 * A table's rows are children, so reading one costs a request of its own on top
 * of the page's. 100 is a single request — Notion's page size — and a table
 * longer than that is a database wearing a table's clothes, which arrives as
 * its own pages anyway.
 */
const MAX_TABLE_ROWS = 100;

type NotionAnnotations = {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  code?: boolean;
};
type NotionRichText = {
  plain_text?: string;
  href?: string | null;
  annotations?: NotionAnnotations;
};
type NotionBlock = {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
};
type NotionProperty = {
  type?: string;
  [key: string]: unknown;
};
type NotionPage = {
  id: string;
  object: string;
  url?: string;
  last_edited_time?: string;
  in_trash?: boolean;
  archived?: boolean;
  parent?: { type?: string };
  properties?: Record<string, NotionProperty>;
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

function runsOf(value: unknown): NotionRichText[] {
  if (!Array.isArray(value)) return [];
  return value.filter((r): r is NotionRichText => Boolean(r) && typeof r === "object");
}

/**
 * The concatenated plain text of a rich-text array, or "".
 *
 * For the places where Markdown would be wrong: a filename, a table cell being
 * measured, a caption used as link text. Titles go through here rather than
 * `inline` because a document called `**Q3** plan.md` is a document whose name
 * is now punctuation.
 */
function plainText(value: unknown): string {
  return runsOf(value)
    .map((r) => r.plain_text ?? "")
    .join("");
}

/**
 * One rich-text run as Markdown, styling and link included.
 *
 * The old version of this function read `plain_text` and stopped, which threw
 * away every annotation and — the part that mattered — **every URL**. A
 * handbook page whose value is thirty links to other things arrived as thirty
 * words. Notion puts the target in `href` on the run itself rather than in a
 * block type, so a link is invisible to anything that only reads block types.
 *
 * Whitespace is moved outside the markers before they are applied. Notion
 * commonly ends a bold run with its trailing space still inside it, and
 * `**bold **` is not bold in any parser — it is two asterisks, a word, and two
 * more asterisks, which is worse than the plain text we started with.
 *
 * Nothing is escaped. An underscore in a Notion sentence is an underscore, and
 * a converter that backslashes every `*`, `_`, `[` and `` ` `` in ordinary prose
 * makes the common case ugly to protect the rare one — in a document whose
 * consumers are a chunker and an embedding model, not a strict renderer.
 */
function runToMarkdown(run: NotionRichText): string {
  const raw = run.plain_text ?? "";
  if (!raw) return "";

  const leading = raw.match(/^\s*/)?.[0] ?? "";
  const trailing = raw.length > leading.length ? (raw.match(/\s*$/)?.[0] ?? "") : "";
  const core = raw.slice(leading.length, raw.length - trailing.length);
  if (!core) return raw;

  const a = run.annotations ?? {};
  let text = core;
  // Code first, so it ends up innermost: `**`code`**` is bold code, while
  // ``**code**`` is a code span that happens to contain asterisks.
  if (a.code) text = `\`${text}\``;
  if (a.strikethrough) text = `~~${text}~~`;
  if (a.italic) text = `*${text}*`;
  if (a.bold) text = `**${text}**`;
  // The link goes outermost, which is the one order that renders: `[**a**](u)`.
  if (run.href) text = `[${text}](${run.href})`;

  return `${leading}${text}${trailing}`;
}

/** A rich-text array as Markdown, or "". */
function inline(value: unknown): string {
  return runsOf(value).map(runToMarkdown).join("");
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
      const text = plainText(prop.title).trim();
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
/**
 * Where a media block points, when saying so is worth anything.
 *
 * Only an `external` URL is returned. A Notion-hosted file arrives as a signed
 * S3 link that expires about an hour later, and this text is stored — so
 * writing one down produces a document full of links that worked once, on the
 * afternoon of the sync, for whoever happened to be looking. The caption is
 * kept either way, because the caption is the part a question can match.
 */
function externalUrl(body: unknown): string | null {
  const value = body as { external?: { url?: string } } | undefined;
  const url = value?.external?.url;
  return typeof url === "string" && url ? url : null;
}

/** A media block: its caption, and its link when the link outlives the sync. */
function mediaToMarkdown(block: NotionBlock, body: unknown, fallback: string): string {
  const caption = inline((body as { caption?: unknown } | undefined)?.caption).trim();
  const url = externalUrl(body);
  const label = caption || fallback;
  if (!url) return caption;
  return block.type === "image" ? `![${label}](${url})` : `[${label}](${url})`;
}

/**
 * One block as a line of Markdown.
 *
 * Markdown rather than bare text because the shape is meaning: a heading tells
 * the chunker where a section starts, and a list that arrives as one run-on
 * paragraph retrieves worse than the same list with its bullets.
 *
 * Returning "" means "this block contributes no line of its own". For a
 * container — a column, a synced block, a table — that is not the same as
 * contributing nothing: `readBlocks` still reads its children, and for those
 * types passes them straight through instead of indenting them.
 */
function blockToMarkdown(block: NotionBlock): string {
  const body = (block as Record<string, { rich_text?: unknown; [k: string]: unknown }>)[block.type];
  const text = inline(body?.rich_text);

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
    case "callout": {
      // A callout is a quote with a pictogram, and the pictogram carries
      // meaning a reader uses — a warning triangle is not a lightbulb. It costs
      // one character to keep.
      const icon = (body as { icon?: { emoji?: string } } | undefined)?.icon?.emoji;
      if (!text) return "";
      return icon ? `> ${icon} ${text}` : `> ${text}`;
    }
    // A toggle's summary is an ordinary line and its contents are its children,
    // which `readBlocks` appends underneath without indenting — the four spaces
    // it used to add turned every collapsed section into a code block.
    case "toggle":
      return text;
    case "code": {
      const language = (body as { language?: string } | undefined)?.language ?? "";
      // Plain text inside a fence. Bold in a code block is not bold, it is two
      // asterisks somebody now has to explain to a reader copying the snippet.
      const source = plainText(body?.rich_text);
      return source ? `\`\`\`${language}\n${source}\n\`\`\`` : "";
    }
    case "equation": {
      const expression = (body as { expression?: string } | undefined)?.expression ?? "";
      return expression ? `$$${expression}$$` : "";
    }
    case "divider":
      return "---";
    case "image":
    case "video":
    case "audio":
    case "pdf":
    case "file":
      return mediaToMarkdown(block, body, block.type);
    case "bookmark":
    case "embed":
    case "link_preview": {
      // The URL is the block here — there is no rich text to fall back on, so
      // the old default branch returned "" and a page of bookmarks imported as
      // an empty document.
      const url = (body as { url?: string } | undefined)?.url ?? "";
      if (!url) return "";
      const caption = inline((body as { caption?: unknown } | undefined)?.caption).trim();
      return caption ? `[${caption}](${url})` : `<${url}>`;
    }
    case "table_row": {
      const cells = (body as { cells?: unknown[] } | undefined)?.cells ?? [];
      const rendered = cells.map((cell) => inline(cell).trim());
      return rendered.some(Boolean) ? `| ${rendered.join(" | ")} |` : "";
    }
    // Containers with no line of their own. Their children are the content and
    // are passed through unindented; see `PASSTHROUGH` in `readBlocks`.
    case "table":
    case "column_list":
    case "column":
    case "synced_block":
      return "";
    // Navigation furniture. It means something in Notion's interface and
    // nothing in a document being read for its sentences.
    case "table_of_contents":
    case "breadcrumb":
      return "";
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

/**
 * The block types whose children are *their* content, indented under them.
 *
 * Only lists. A nested bullet has to stay nested or the outline collapses, and
 * two spaces is what makes it one — not the four the first version used, which
 * is also Markdown's marker for a code block and turned every nested paragraph,
 * toggle body and table row into a monospaced blob nobody could retrieve a
 * sentence from.
 */
const INDENTS_CHILDREN = new Set(["bulleted_list_item", "numbered_list_item", "to_do"]);

/**
 * Containers that are layout, not content.
 *
 * Their children are ordinary blocks that happen to sit inside a wrapper, so
 * they are passed through at the same level and the wrapper costs nothing. They
 * also do not spend a level of `MAX_BLOCK_DEPTH`: a two-column layout is one
 * `column_list` and one `column` before any writing starts, and charging two
 * levels for it would mean a page laid out in columns imports its paragraphs
 * and loses every list inside them.
 */
const PASSTHROUGH = new Set(["column_list", "column", "synced_block"]);

/**
 * An absolute stop, since `PASSTHROUGH` does not spend depth.
 *
 * Notion will not nest columns like this and a malformed reply cannot make it
 * do so, but "cannot happen" is how a sync ends up recursing until the Worker
 * is killed, and there is no error to read when it does.
 */
const MAX_HOPS = 8;

/**
 * One table, as a table.
 *
 * Rows are children of the `table` block, which is why the first version got
 * this so wrong: it indented them four spaces like any other nested block, so
 * every table in Notion arrived as a code block — and it never wrote the
 * delimiter row, without which the remaining lines are not a table in any
 * parser. `docs/integrations.md` claimed tables survived. They did not.
 *
 * A table with no header row still gets a delimiter, under a row of empty
 * cells. That is what Notion itself shows for a headerless table, and it is the
 * only shape that stays a table once written down.
 */
async function readTable(ctx: ProviderContext, block: NotionBlock): Promise<string[]> {
  const body = (block as Record<string, { has_column_header?: boolean } | undefined>)["table"];
  const query = new URLSearchParams({ page_size: String(MAX_TABLE_ROWS) });
  const data = (await notionFetch(ctx, `/blocks/${block.id}/children?${query}`)) as {
    results?: NotionBlock[];
  };

  const rows = (data.results ?? [])
    .filter((row) => row.type === "table_row")
    .map((row) => {
      const cells = (row as Record<string, { cells?: unknown[] } | undefined>)["table_row"]?.cells;
      return (cells ?? []).map((cell) => inline(cell).trim());
    });
  if (!rows.length) return [];

  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row: string[]) =>
    `| ${[...row, ...Array(width - row.length).fill("")].join(" | ")} |`;

  const header = body?.has_column_header ? rows[0] : Array<string>(width).fill("");
  const rest = body?.has_column_header ? rows.slice(1) : rows;

  return [pad(header), `| ${Array<string>(width).fill("---").join(" | ")} |`, ...rest.map(pad)];
}

/** Blocks under one parent, flattened to Markdown, following nesting to a depth. */
async function readBlocks(
  ctx: ProviderContext,
  parentId: string,
  depth: number,
  hops = 0,
): Promise<string[]> {
  const lines: string[] = [];
  let cursor: string | undefined;
  if (hops >= MAX_HOPS) return lines;

  for (let page = 0; page < MAX_BLOCK_PAGES; page++) {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const data = (await notionFetch(ctx, `/blocks/${parentId}/children?${query}`)) as {
      results?: NotionBlock[];
      has_more?: boolean;
      next_cursor?: string | null;
    };

    for (const block of data.results ?? []) {
      // A table's children are its rows, and they are read as one thing rather
      // than as blocks that happen to be underneath something.
      if (block.type === "table") {
        if (block.has_children && depth < MAX_BLOCK_DEPTH) {
          lines.push(...(await readTable(ctx, block)));
        }
        continue;
      }

      const line = blockToMarkdown(block);
      if (line) lines.push(line);

      if (!block.has_children || block.type === "child_page") continue;

      const passthrough = PASSTHROUGH.has(block.type);
      if (!passthrough && depth >= MAX_BLOCK_DEPTH) continue;

      const nested = await readBlocks(ctx, block.id, passthrough ? depth : depth + 1, hops + 1);
      if (INDENTS_CHILDREN.has(block.type)) {
        for (const nestedLine of nested) lines.push(`  ${nestedLine}`);
      } else {
        // A toggle's contents, a callout's second paragraph, a column's whole
        // body: content that belongs to the flow of the page rather than under
        // a bullet, and indenting it would only misrepresent it.
        lines.push(...nested);
      }
    }

    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  return lines;
}

/** Whether two adjacent blocks are the kind that should stay packed together. */
function sameRun(a: string, b: string): boolean {
  const shapes = [/^\s*(?:[-*+]|\d+\.)\s/, /^\s*\|/, /^\s*>/];
  return shapes.some((shape) => shape.test(a) && shape.test(b));
}

/**
 * Blocks into a document, with the blank lines Markdown needs.
 *
 * Joining on a single newline — which is what this used to do — glues two
 * paragraphs into one, because that is precisely what a single newline means in
 * Markdown. The page read correctly in Notion and arrived here as half as many
 * paragraphs, each twice as long, which is the shape a chunker splits worst.
 *
 * List items, table rows and quote lines are the exception and keep their tight
 * spacing: a blank line between two bullets ends the list and starts another.
 */
function joinBlocks(blocks: string[]): string {
  const out: string[] = [];
  for (const block of blocks) {
    if (out.length && !sameRun(out[out.length - 1], block)) out.push("");
    out.push(block);
  }
  return out.join("\n");
}

/** One property value as a string, or "" for the shapes worth no line. */
function propertyValue(prop: NotionProperty): string {
  const named = (value: unknown) => (value as { name?: string } | undefined)?.name ?? "";

  switch (prop.type) {
    case "rich_text":
      return inline(prop.rich_text).trim();
    case "number":
      return prop.number === null || prop.number === undefined ? "" : String(prop.number);
    case "select":
    case "status":
      return named(prop[prop.type]);
    case "multi_select":
      return (Array.isArray(prop.multi_select) ? prop.multi_select : [])
        .map(named)
        .filter(Boolean)
        .join(", ");
    case "date": {
      const date = prop.date as { start?: string; end?: string } | undefined;
      if (!date?.start) return "";
      return date.end ? `${date.start} → ${date.end}` : date.start;
    }
    case "checkbox":
      return prop.checkbox ? "Yes" : "No";
    case "url":
    case "email":
    case "phone_number":
      return typeof prop[prop.type] === "string" ? (prop[prop.type] as string) : "";
    case "people":
      return (Array.isArray(prop.people) ? prop.people : []).map(named).filter(Boolean).join(", ");
    case "files":
      return (Array.isArray(prop.files) ? prop.files : [])
        .map((f) => (f as { name?: string } | undefined)?.name ?? "")
        .filter(Boolean)
        .join(", ");
    case "formula": {
      const formula = prop.formula as Record<string, unknown> | undefined;
      const inner = formula?.[String(formula?.type)];
      if (inner === null || inner === undefined) return "";
      if (typeof inner === "boolean") return inner ? "Yes" : "No";
      if (typeof inner === "object") return (inner as { start?: string }).start ?? "";
      return String(inner);
    }
    case "created_time":
    case "last_edited_time":
      return typeof prop[prop.type] === "string" ? (prop[prop.type] as string) : "";
    case "unique_id": {
      const id = prop.unique_id as { prefix?: string | null; number?: number } | undefined;
      if (id?.number === undefined) return "";
      return id.prefix ? `${id.prefix}-${id.number}` : String(id.number);
    }
    // relation and rollup arrive as ids and nested aggregates — a line of UUIDs
    // is not something a question can match, and resolving them is a request
    // per row per property. title is the document's own heading, already there.
    default:
      return "";
  }
}

/**
 * A database row's properties, as lines above its body.
 *
 * The reason this exists: in Notion a database row's content very often *is*
 * its properties — status, owner, dates, a one-line summary — and its page body
 * is empty. Reading only the blocks imported those rows as a title and nothing
 * else, so a bundle full of them looked synced and answered nothing.
 *
 * Only for rows. An ordinary page's sole property is its title, which is
 * already the heading, so this returns nothing and those pages import exactly
 * as they did before.
 */
function propertiesToMarkdown(page: NotionPage | undefined): string[] {
  if (page?.parent?.type !== "database_id") return [];

  const lines: string[] = [];
  for (const [name, prop] of Object.entries(page.properties ?? {})) {
    if (!prop || prop.type === "title") continue;
    const value = propertyValue(prop);
    if (value) lines.push(`- **${name}:** ${value}`);
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
          // `search` has already returned this row's properties. Carrying them
          // to `readFile` is how a database row's real content — which is its
          // properties, not its usually-empty body — gets imported without a
          // `/pages/{id}` call per document per sync.
          listing: page as unknown as Record<string, unknown>,
        });
      }

      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }

    return files;
  },

  async readFile(ctx: ProviderContext, file: RemoteFile): Promise<string> {
    const properties = propertiesToMarkdown(file.listing as NotionPage | undefined);
    const body = await readBlocks(ctx, file.externalId, 0);
    // The title is prepended as a heading because the body does not contain it
    // — in Notion the title is a property, not the first block — and a chunk
    // that never names its own document retrieves badly for the question that
    // uses the document's name.
    const title = file.name.replace(/\.md$/, "");
    return `# ${title}\n\n${joinBlocks([...properties, ...body])}`.trim();
  },
};
