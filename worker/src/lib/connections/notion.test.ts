import { describe, it, expect, vi } from "vitest";
import { notionProvider } from "./notion";
import { ProviderError, type ProviderContext } from "./types";

const ctx = (fetchImpl: typeof fetch): ProviderContext => ({
  token: { accessToken: "secret_token" },
  config: {},
  fetchImpl,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function page(overrides: Record<string, unknown> = {}) {
  return {
    object: "page",
    id: "page-1",
    url: "https://notion.so/page-1",
    last_edited_time: "2026-09-01T10:00:00.000Z",
    properties: { Name: { type: "title", title: [{ plain_text: "Handbook" }] } },
    ...overrides,
  };
}

describe("notion provider", () => {
  it("is off until the deployment registers a client", () => {
    expect(notionProvider.isConfigured({})).toBe(false);
    expect(notionProvider.isConfigured({ NOTION_CLIENT_ID: "id" })).toBe(false);
    expect(
      notionProvider.isConfigured({ NOTION_CLIENT_ID: "id", NOTION_CLIENT_SECRET: "secret" }),
    ).toBe(true);
  });

  it("sends the browser somewhere that carries the state back", () => {
    const url = new URL(
      notionProvider.authorizeUrl(
        { NOTION_CLIENT_ID: "client-1" },
        "the-state",
        "https://api.example.com/connections/callback",
      ),
    );
    expect(url.origin + url.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(url.searchParams.get("state")).toBe("the-state");
    expect(url.searchParams.get("owner")).toBe("user");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/connections/callback",
    );
  });

  it("names the connection after the Notion workspace it was given", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ access_token: "secret_abc", workspace_name: "Covan HQ" }),
    ) as unknown as typeof fetch;

    const result = await notionProvider.exchangeCode(
      { NOTION_CLIENT_ID: "id", NOTION_CLIENT_SECRET: "shh" },
      "code-1",
      "https://api.example.com/connections/callback",
      fetchImpl,
    );

    expect(result.token).toEqual({ accessToken: "secret_abc" });
    expect(result.accountLabel).toBe("Covan HQ");
    // Nothing to scope: Notion's own picker decided, and copying that selection
    // here would be a copy that goes stale.
    expect(result.config).toEqual({});
  });

  it("lists the pages the picker gave it, and skips the trashed ones", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        results: [
          page(),
          page({ id: "page-2", in_trash: true }),
          page({ id: "page-3", archived: true }),
          { object: "database", id: "db-1" },
        ],
        has_more: false,
      }),
    ) as unknown as typeof fetch;

    const files = await notionProvider.listFiles(ctx(fetchImpl));

    expect(files).toEqual([
      {
        externalId: "page-1",
        name: "Handbook.md",
        version: "2026-09-01T10:00:00.000Z",
        url: "https://notion.so/page-1",
        // Carried so `readFile` can render a database row's properties without
        // asking for a page `search` has already returned in full.
        listing: page(),
      },
    ]);
  });

  // The title property on a database row is called whatever the person named
  // the column, so it can only be found by type.
  it("finds the title however the column was named", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        results: [
          page({
            properties: {
              "Şirket Politikası": { type: "title", title: [{ plain_text: "İzin Politikası" }] },
              Owner: { type: "people" },
            },
          }),
        ],
      }),
    ) as unknown as typeof fetch;

    const [file] = await notionProvider.listFiles(ctx(fetchImpl));
    expect(file.name).toBe("İzin Politikası.md");
  });

  it("calls an untitled page what Notion calls it", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ results: [page({ properties: { Name: { type: "title", title: [] } } })] }),
    ) as unknown as typeof fetch;

    const [file] = await notionProvider.listFiles(ctx(fetchImpl));
    expect(file.name).toBe("Untitled.md");
  });

  it("reads a page as Markdown, keeping the shape that makes it retrievable", async () => {
    const blocks = {
      results: [
        { id: "b1", type: "heading_2", heading_2: { rich_text: [{ plain_text: "Leave" }] } },
        {
          id: "b2",
          type: "paragraph",
          paragraph: { rich_text: [{ plain_text: "Twenty days a year." }] },
        },
        {
          id: "b3",
          type: "bulleted_list_item",
          bulleted_list_item: { rich_text: [{ plain_text: "Ask in advance" }] },
        },
        {
          id: "b4",
          type: "to_do",
          to_do: { rich_text: [{ plain_text: "Sign it" }], checked: true },
        },
        // Found by `search` in its own right, so following it here would index
        // the same text twice.
        { id: "b5", type: "child_page", child_page: { title: "Sub page" }, has_children: true },
      ],
      has_more: false,
    };
    const fetchImpl = vi.fn(async () => json(blocks)) as unknown as typeof fetch;

    const text = await notionProvider.readFile(ctx(fetchImpl), {
      externalId: "page-1",
      name: "Handbook.md",
      version: "v1",
      url: null,
    });

    expect(text).toBe(
      [
        "# Handbook",
        "",
        "## Leave",
        "",
        "Twenty days a year.",
        "",
        // Two list items in a row and no blank line between them: a blank line
        // there ends the list and starts a second one.
        "- Ask in advance",
        "- [x] Sign it",
      ].join("\n"),
    );
    // The child page contributed nothing, so nothing was fetched for it.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("indents nested blocks so a nested list stays one", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/blocks/page-1/")) {
        return json({
          results: [
            {
              id: "b1",
              type: "bulleted_list_item",
              bulleted_list_item: { rich_text: [{ plain_text: "Parent" }] },
              has_children: true,
            },
          ],
        });
      }
      return json({
        results: [
          {
            id: "b2",
            type: "bulleted_list_item",
            bulleted_list_item: { rich_text: [{ plain_text: "Child" }] },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const text = await notionProvider.readFile(ctx(fetchImpl), {
      externalId: "page-1",
      name: "P.md",
      version: "v1",
      url: null,
    });

    // Two spaces, not four. Four is Markdown's code-block marker, and the
    // version that used it turned every nested block into a monospaced blob.
    expect(text).toContain("- Parent\n  - Child");
  });

  /**
   * Read one page whose top-level blocks are `blocks`, with `children` keyed by
   * the parent block id. Every failure below was a real defect: the first
   * version of this converter read `plain_text` and block types and nothing
   * else, so links, tables, media and database rows all arrived as either
   * nothing at all or as a code block.
   */
  const readWith = async (
    blocks: unknown[],
    children: Record<string, unknown[]> = {},
    listing?: unknown,
  ) => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const id = String(input).match(/\/blocks\/([^/]+)\/children/)?.[1] ?? "";
      if (id === "page-1") return json({ results: blocks, has_more: false });
      return json({ results: children[id] ?? [], has_more: false });
    }) as unknown as typeof fetch;

    return notionProvider.readFile(ctx(fetchImpl), {
      externalId: "page-1",
      name: "P.md",
      version: "v1",
      url: null,
      ...(listing ? { listing: listing as Record<string, unknown> } : {}),
    });
  };

  it("keeps the links, which were the whole value of the page", async () => {
    const text = await readWith([
      {
        id: "b1",
        type: "paragraph",
        paragraph: {
          rich_text: [
            { plain_text: "See " },
            { plain_text: "the policy", href: "https://example.com/policy" },
            { plain_text: " and ", annotations: {} },
            { plain_text: "ask Ayşe", annotations: { bold: true } },
          ],
        },
      },
    ]);

    expect(text).toContain("See [the policy](https://example.com/policy) and **ask Ayşe**");
  });

  it("puts the space outside the markers, where it renders", async () => {
    // Notion routinely ends a bold run with the trailing space inside it, and
    // `**bold **` is not bold in any parser.
    const text = await readWith([
      {
        id: "b1",
        type: "paragraph",
        paragraph: {
          rich_text: [
            { plain_text: "Deadline ", annotations: { bold: true } },
            { plain_text: "is Friday" },
          ],
        },
      },
    ]);

    expect(text).toContain("**Deadline** is Friday");
  });

  it("reads a table as a table, not as a code block", async () => {
    const text = await readWith(
      [{ id: "t1", type: "table", table: { has_column_header: true }, has_children: true }],
      {
        t1: [
          {
            id: "r1",
            type: "table_row",
            table_row: { cells: [[{ plain_text: "Plan" }], [{ plain_text: "Seats" }]] },
          },
          {
            id: "r2",
            type: "table_row",
            table_row: { cells: [[{ plain_text: "Team" }], [{ plain_text: "5" }]] },
          },
        ],
      },
    );

    expect(text).toContain(["| Plan | Seats |", "| --- | --- |", "| Team | 5 |"].join("\n"));
    // The four-space indent it used to get is what made it a code block.
    expect(text).not.toContain("    | Plan");
  });

  it("gives a headerless table a delimiter anyway", async () => {
    const text = await readWith(
      [{ id: "t1", type: "table", table: { has_column_header: false }, has_children: true }],
      {
        t1: [
          {
            id: "r1",
            type: "table_row",
            table_row: { cells: [[{ plain_text: "a" }], [{ plain_text: "b" }]] },
          },
        ],
      },
    );

    expect(text).toContain(["|  |  |", "| --- | --- |", "| a | b |"].join("\n"));
  });

  it("passes a column's contents through at the level they read at", async () => {
    const text = await readWith(
      [{ id: "cl", type: "column_list", column_list: {}, has_children: true }],
      {
        cl: [{ id: "c1", type: "column", column: {}, has_children: true }],
        c1: [
          {
            id: "p1",
            type: "bulleted_list_item",
            bulleted_list_item: { rich_text: [{ plain_text: "In a column" }] },
            has_children: true,
          },
        ],
        // Two structural wrappers deep and the list underneath still nests,
        // because layout does not spend a level of MAX_BLOCK_DEPTH.
        p1: [
          {
            id: "p2",
            type: "bulleted_list_item",
            bulleted_list_item: { rich_text: [{ plain_text: "Nested" }] },
          },
        ],
      },
    );

    expect(text).toContain("- In a column\n  - Nested");
  });

  it("keeps a toggle's contents out of a code block", async () => {
    const text = await readWith(
      [
        {
          id: "t1",
          type: "toggle",
          toggle: { rich_text: [{ plain_text: "Details" }] },
          has_children: true,
        },
      ],
      {
        t1: [
          { id: "p1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "The body." }] } },
        ],
      },
    );

    expect(text).toContain("Details\n\nThe body.");
  });

  it("keeps a caption but not a link that expires before anybody clicks it", async () => {
    const text = await readWith([
      {
        id: "i1",
        type: "image",
        image: {
          caption: [{ plain_text: "The org chart" }],
          type: "file",
          // Notion-hosted: a signed URL good for about an hour.
          file: { url: "https://s3.example.com/signed?expires=soon" },
        },
      },
      {
        id: "i2",
        type: "image",
        image: {
          caption: [{ plain_text: "The logo" }],
          type: "external",
          external: { url: "https://example.com/logo.png" },
        },
      },
    ]);

    expect(text).toContain("The org chart");
    expect(text).not.toContain("s3.example.com");
    expect(text).toContain("![The logo](https://example.com/logo.png)");
  });

  it("imports a bookmark, which used to import as nothing", async () => {
    const text = await readWith([
      { id: "b1", type: "bookmark", bookmark: { url: "https://example.com/pricing", caption: [] } },
      {
        id: "b2",
        type: "callout",
        callout: { rich_text: [{ plain_text: "Mind the gap" }], icon: { emoji: "⚠️" } },
      },
      { id: "b3", type: "equation", equation: { expression: "e = mc^2" } },
    ]);

    expect(text).toContain("<https://example.com/pricing>");
    expect(text).toContain("> ⚠️ Mind the gap");
    expect(text).toContain("$$e = mc^2$$");
  });

  it("leaves a code block's contents alone", async () => {
    // Emphasis inside a fence is not emphasis, it is punctuation somebody now
    // has to explain to whoever copies the snippet.
    const text = await readWith([
      {
        id: "c1",
        type: "code",
        code: {
          language: "sql",
          rich_text: [{ plain_text: "select *", annotations: { bold: true } }],
        },
      },
    ]);

    expect(text).toContain("```sql\nselect *\n```");
  });

  it("imports a database row's properties, which are usually all it has", async () => {
    const text = await readWith(
      [],
      {},
      {
        object: "page",
        id: "page-1",
        parent: { type: "database_id" },
        properties: {
          Name: { type: "title", title: [{ plain_text: "Renew the SOC 2" }] },
          Status: { type: "status", status: { name: "In review" } },
          Owner: { type: "people", people: [{ name: "Ayşe" }] },
          Due: { type: "date", date: { start: "2026-10-01" } },
          Tags: { type: "multi_select", multi_select: [{ name: "legal" }, { name: "q4" }] },
          Blocked: { type: "checkbox", checkbox: false },
          Notes: { type: "rich_text", rich_text: [{ plain_text: "Ask the auditor." }] },
          // Ids and nested aggregates: nothing a question can match.
          Parent: { type: "relation", relation: [{ id: "abc" }] },
        },
      },
    );

    expect(text).toContain("- **Status:** In review");
    expect(text).toContain("- **Owner:** Ayşe");
    expect(text).toContain("- **Due:** 2026-10-01");
    expect(text).toContain("- **Tags:** legal, q4");
    expect(text).toContain("- **Blocked:** No");
    expect(text).toContain("- **Notes:** Ask the auditor.");
    expect(text).not.toContain("Parent");
  });

  it("leaves an ordinary page's properties alone", async () => {
    // Its only property is the title, which is already the heading. A page that
    // is not a database row imports exactly as it did before.
    const text = await readWith(
      [{ id: "p1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Body." }] } }],
      {},
      { object: "page", id: "page-1", parent: { type: "workspace" }, properties: {} },
    );

    expect(text).toBe("# P\n\nBody.");
  });

  // A revoked grant is not weather. Retrying it every six hours forever is how
  // an integration becomes a log nobody reads.
  it("treats a revoked grant as final and a bad afternoon as temporary", async () => {
    const refusing = vi.fn(async () => json({ message: "unauthorized" }, 401));
    await expect(
      notionProvider.listFiles(ctx(refusing as unknown as typeof fetch)),
    ).rejects.toMatchObject({ retryable: false });

    const rateLimited = vi.fn(async () => json({ message: "rate limited" }, 429));
    await expect(
      notionProvider.listFiles(ctx(rateLimited as unknown as typeof fetch)),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("refuses a token exchange that produced no token", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ workspace_name: "Covan HQ" }),
    ) as unknown as typeof fetch;
    await expect(
      notionProvider.exchangeCode(
        { NOTION_CLIENT_ID: "id", NOTION_CLIENT_SECRET: "shh" },
        "code",
        "https://api.example.com/connections/callback",
        fetchImpl,
      ),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});
