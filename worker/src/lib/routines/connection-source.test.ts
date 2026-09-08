// worker/src/lib/routines/connection-source.test.ts
import { describe, it, expect } from "vitest";
import { fetchConnectionItems } from "./connection-source";

/**
 * A Supabase-shaped stub for the two reads this module makes: the connection,
 * scoped by workspace, and that connection's documents.
 *
 * `filters` records what each read was scoped by, because the security property
 * this module has to hold is not "it returned the right rows" — it is "it
 * refused to look outside the routine's own workspace". A stub that answered
 * every query with the same rows would pass a test written against the return
 * value alone.
 */
function makeDb(over: { connection?: unknown; documents?: unknown[] } = {}) {
  const filters: Array<{ table: string; column: string; value: unknown }> = [];

  const db = {
    from: (table: string) => ({
      select: () => {
        const chain: any = {
          eq: (column: string, value: unknown) => {
            filters.push({ table, column, value });
            return chain;
          },
          is: (column: string, value: unknown) => {
            filters.push({ table, column, value });
            return chain;
          },
          order: () => chain,
          limit: async () => ({ data: over.documents ?? [], error: null }),
          maybeSingle: async () => ({
            data: over.connection === undefined ? { id: "cn1" } : over.connection,
            error: null,
          }),
        };
        return chain;
      },
    }),
  };

  return { db: db as any, filters };
}

const doc = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  name: "Handbook",
  content: "Holiday policy is twenty-five days.",
  external_url: "https://notion.so/handbook",
  external_version: "v1",
  synced_at: "2026-09-05T10:00:00Z",
  ...over,
});

describe("fetchConnectionItems", () => {
  it("returns each document as a feed item keyed by id and version", async () => {
    const { db } = makeDb({ documents: [doc()] });

    const items = await fetchConnectionItems(db, { workspaceId: "w1", connectionId: "cn1" });

    expect(items).toEqual([
      {
        key: "d1:v1",
        title: "Handbook",
        link: "https://notion.so/handbook",
        publishedAt: "2026-09-05T10:00:00Z",
        summary: "Holiday policy is twenty-five days.",
      },
    ]);
  });

  // The whole point of putting the version in the key: `diffItems` decides what
  // is new by identity, so a document whose text was edited at the source has to
  // arrive under a key the cursor has not seen, or it would sync and never be
  // reported again.
  it("gives an edited document a key the cursor has not seen", async () => {
    const before = await fetchConnectionItems(makeDb({ documents: [doc()] }).db, {
      workspaceId: "w1",
      connectionId: "cn1",
    });
    const after = await fetchConnectionItems(
      makeDb({ documents: [doc({ external_version: "v2" })] }).db,
      { workspaceId: "w1", connectionId: "cn1" },
    );

    expect(before[0].key).not.toEqual(after[0].key);
  });

  it("scopes the connection lookup to the routine's own workspace", async () => {
    const { db, filters } = makeDb({ documents: [] });

    await fetchConnectionItems(db, { workspaceId: "w1", connectionId: "cn1" });

    expect(filters).toContainEqual({ table: "connections", column: "id", value: "cn1" });
    expect(filters).toContainEqual({
      table: "connections",
      column: "workspace_id",
      value: "w1",
    });
  });

  // The executor holds a service-role client, so nothing below it is filtering
  // by tenancy. 0047's policy stops a routine being *written* with someone
  // else's connection; this stops a row written before 0047 — or by anything
  // holding the service role — from being read.
  it("refuses a connection that is not in the routine's workspace", async () => {
    const { db } = makeDb({ connection: null });

    await expect(
      fetchConnectionItems(db, { workspaceId: "w1", connectionId: "cn-elsewhere" }),
    ).rejects.toThrow(/connection/i);
  });

  it("refuses a routine whose source_config names no connection", async () => {
    const { db } = makeDb();

    await expect(
      fetchConnectionItems(db, { workspaceId: "w1", connectionId: undefined }),
    ).rejects.toThrow(/connectionId/);
  });

  // A document the reconciler withdrew has stopped grounding answers; reporting
  // it as new here would contradict that.
  it("asks only for documents that are not soft-deleted", async () => {
    const { db, filters } = makeDb({ documents: [] });

    await fetchConnectionItems(db, { workspaceId: "w1", connectionId: "cn1" });

    expect(filters).toContainEqual({ table: "documents", column: "deleted_at", value: null });
    expect(filters).toContainEqual({
      table: "documents",
      column: "connection_id",
      value: "cn1",
    });
  });

  // A Notion page with no title and no URL still has to produce a usable item
  // rather than an empty bullet, because the model is given nothing else.
  it("falls back to a readable title and an empty link", async () => {
    const { db } = makeDb({
      documents: [doc({ name: "", external_url: null, external_version: null })],
    });

    const items = await fetchConnectionItems(db, { workspaceId: "w1", connectionId: "cn1" });

    expect(items[0].title).toBe("Untitled document");
    expect(items[0].link).toBe("");
    // No version to key on, so the sync time stands in — an edited document
    // still arrives under a key the cursor has not seen.
    expect(items[0].key).toBe("d1:2026-09-05T10:00:00Z");
  });
});
