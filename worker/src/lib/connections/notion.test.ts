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
        "Twenty days a year.",
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

    expect(text).toContain("- Parent\n    - Child");
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
