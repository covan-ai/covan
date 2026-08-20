import { describe, it, expect } from "vitest";
import { parseFeed, diffItems, type FeedItem, type Cursor } from "./feed";

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>SaaS</title>
  <entry>
    <id>t3_bbb</id>
    <title>Second post</title>
    <link href="https://reddit.com/r/saas/bbb"/>
    <updated>2026-08-14T10:00:00+00:00</updated>
    <content type="html">&lt;p&gt;body two&lt;/p&gt;</content>
  </entry>
  <entry>
    <id>t3_aaa</id>
    <title>First post</title>
    <link href="https://reddit.com/r/saas/aaa"/>
    <updated>2026-08-14T09:00:00+00:00</updated>
    <content type="html">&lt;p&gt;body one&lt;/p&gt;</content>
  </entry>
</feed>`;

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Changelog</title>
  <item>
    <guid>https://example.com/2</guid>
    <title>Release 2</title>
    <link>https://example.com/2</link>
    <pubDate>Thu, 14 Aug 2026 10:00:00 GMT</pubDate>
    <description>notes two</description>
  </item>
</channel></rss>`;

const item = (key: string, publishedAt: string | null): FeedItem => ({
  key,
  title: key,
  link: `https://example.com/${key}`,
  publishedAt,
  summary: "",
});

describe("parseFeed", () => {
  it("parses Atom entries newest-first with id, link href and content", () => {
    const items = parseFeed(ATOM);
    expect(items).toHaveLength(2);
    expect(items[0].key).toBe("t3_bbb");
    expect(items[0].title).toBe("Second post");
    expect(items[0].link).toBe("https://reddit.com/r/saas/bbb");
    expect(items[0].publishedAt).toBe("2026-08-14T10:00:00.000Z");
    expect(items[0].summary).toContain("body two");
  });

  it("parses RSS 2.0 items", () => {
    const items = parseFeed(RSS);
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("https://example.com/2");
    expect(items[0].publishedAt).toBe("2026-08-14T10:00:00.000Z");
    expect(items[0].summary).toBe("notes two");
  });

  it("returns an empty list for a document with no entries", () => {
    expect(parseFeed(`<?xml version="1.0"?><feed></feed>`)).toEqual([]);
  });

  it("throws on content that is not xml", () => {
    expect(() => parseFeed("<html><body>nope")).toThrow();
  });

  it("prefers the alternate link when an entry has multiple links", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>t3_ccc</id>
    <title>Third post</title>
    <link rel="self" href="https://reddit.com/api/self/ccc"/>
    <link rel="alternate" href="https://reddit.com/r/saas/ccc"/>
    <updated>2026-08-14T11:00:00+00:00</updated>
    <content type="html">&lt;p&gt;body three&lt;/p&gt;</content>
  </entry>
</feed>`;
    const items = parseFeed(xml);
    expect(items).toHaveLength(1);
    expect(items[0].link).toBe("https://reddit.com/r/saas/ccc");
  });
});

describe("diffItems", () => {
  it("delivers nothing on the first run and records the baseline", () => {
    const items = [item("b", "2026-08-14T10:00:00Z"), item("a", "2026-08-14T09:00:00Z")];
    const { newItems, nextCursor } = diffItems(items, null);
    expect(newItems).toEqual([]);
    expect(nextCursor.seenKeys).toEqual(["b", "a"]);
    expect(nextCursor.lastPublishedAt).toBe("2026-08-14T10:00:00Z");
  });

  it("returns only entries whose key has not been seen", () => {
    const cursor: Cursor = {
      seenKeys: ["a"],
      lastPublishedAt: "2026-08-14T09:00:00Z",
      etag: null,
      contentHash: null,
    };
    const items = [
      item("c", "2026-08-14T11:00:00Z"),
      item("b", "2026-08-14T10:00:00Z"),
      item("a", "2026-08-14T09:00:00Z"),
    ];
    const { newItems, nextCursor } = diffItems(items, cursor);
    expect(newItems.map((i) => i.key)).toEqual(["c", "b"]);
    expect(nextCursor.seenKeys).toContain("a");
    expect(nextCursor.seenKeys).toContain("c");
  });

  it("returns nothing when the feed is unchanged", () => {
    const cursor: Cursor = {
      seenKeys: ["b", "a"],
      lastPublishedAt: "2026-08-14T10:00:00Z",
      etag: null,
      contentHash: null,
    };
    const items = [item("b", "2026-08-14T10:00:00Z"), item("a", "2026-08-14T09:00:00Z")];
    expect(diffItems(items, cursor).newItems).toEqual([]);
  });

  it("caps a burst and reports the overflow, marking the skipped items as seen", () => {
    const cursor: Cursor = {
      seenKeys: ["old"],
      lastPublishedAt: null,
      etag: null,
      contentHash: null,
    };
    const items = Array.from({ length: 25 }, (_, i) =>
      item(`k${i}`, new Date(Date.UTC(2026, 7, 14, 0, 25 - i)).toISOString()),
    );
    const { newItems, nextCursor, overflow } = diffItems(items, cursor, 10);
    expect(newItems).toHaveLength(10);
    expect(newItems[0].key).toBe("k0");
    expect(overflow).toBe(15);
    expect(nextCursor.seenKeys).toContain("k24");
  });

  it("bounds seenKeys so the cursor cannot grow without limit", () => {
    let cursor: Cursor = { seenKeys: [], lastPublishedAt: null, etag: null, contentHash: null };
    for (let round = 0; round < 30; round++) {
      cursor = diffItems([item(`r${round}`, null)], cursor).nextCursor;
    }
    expect(cursor.seenKeys.length).toBeLessThanOrEqual(100);
    expect(cursor.seenKeys[0]).toBe("r29");
  });

  it("tolerates entries with no date", () => {
    const cursor: Cursor = {
      seenKeys: ["a"],
      lastPublishedAt: null,
      etag: null,
      contentHash: null,
    };
    const { newItems } = diffItems([item("b", null), item("a", null)], cursor);
    expect(newItems.map((i) => i.key)).toEqual(["b"]);
  });

  it("sorts dated entries newest-first, dateless entries last, and records the newest date", () => {
    const cursor: Cursor = { seenKeys: [], lastPublishedAt: null, etag: null, contentHash: null };
    const items = [
      item("d1", null),
      item("b", "2026-08-14T10:00:00Z"),
      item("d2", null),
      item("a", "2026-08-14T09:00:00Z"),
    ];
    const { newItems, nextCursor } = diffItems(items, cursor);
    expect(newItems.map((i) => i.key)).toEqual(["b", "a", "d1", "d2"]);
    expect(nextCursor.lastPublishedAt).toBe("2026-08-14T10:00:00Z");
  });

  it("keeps every key from a round larger than SEEN_LIMIT, so the same round never repeats as new", () => {
    const cursor: Cursor = { seenKeys: [], lastPublishedAt: null, etag: null, contentHash: null };
    const items = Array.from({ length: 150 }, (_, i) =>
      item(`k${i}`, new Date(Date.UTC(2026, 7, 14, 0, 150 - i)).toISOString()),
    );
    const { newItems, nextCursor, overflow } = diffItems(items, cursor, 10);
    expect(newItems).toHaveLength(10);
    expect(overflow).toBe(140);
    for (const i of items) {
      expect(nextCursor.seenKeys).toContain(i.key);
    }

    const second = diffItems(items, nextCursor, 10);
    expect(second.newItems).toEqual([]);
  });
});
