import { XMLParser, XMLValidator } from "fast-xml-parser";

export type FeedItem = {
  /** Stable per-entry identity: Atom <id>, RSS <guid>, else the link. */
  key: string;
  title: string;
  link: string;
  /** ISO-8601, or null when the feed omits a date. */
  publishedAt: string | null;
  summary: string;
};

export type Cursor = {
  /** Most recent first. Bounded — see SEEN_LIMIT. */
  seenKeys: string[];
  lastPublishedAt: string | null;
  etag: string | null;
  /** Web watch only: hash of the last body we saw. */
  contentHash: string | null;
};

const SEEN_LIMIT = 100;
const DEFAULT_MAX_PER_RUN = 10;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

const text = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "object") return String((v as Record<string, unknown>)["#text"] ?? "");
  return String(v);
};

const toIso = (raw: string): string | null => {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Parses Atom or RSS 2.0. Reddit's per-subreddit feed is Atom. */
export function parseFeed(xml: string): FeedItem[] {
  // XMLParser is lenient and will happily return `{}` for garbage. Without this
  // gate a broken feed reads as "nothing new" forever instead of surfacing as a
  // failed run.
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(`invalid xml: ${validation.err.msg}`);
  }

  const doc = parser.parse(xml) as Record<string, any>;

  if (doc.feed) {
    const entries = doc.feed.entry ? [].concat(doc.feed.entry) : [];
    return entries.map((e: any) => {
      // Atom entries can carry several <link> elements (self, alternate,
      // replies, enclosures). Prefer rel="alternate" (or an unrelled link,
      // the common case) over whichever happens to come first in the doc.
      const links = e.link ? [].concat(e.link) : [];
      const alternate = links.find((l: any) => {
        const rel = l?.["@_rel"];
        return rel === undefined || rel === "alternate";
      });
      const link = text((alternate ?? links[0])?.["@_href"] ?? e.link);
      return {
        key: text(e.id) || link,
        title: text(e.title),
        link,
        publishedAt: toIso(text(e.updated) || text(e.published)),
        summary: text(e.content) || text(e.summary),
      };
    });
  }

  if (doc.rss?.channel) {
    const items = doc.rss.channel.item ? [].concat(doc.rss.channel.item) : [];
    return items.map((i: any) => {
      const link = text(i.link);
      return {
        key: text(i.guid) || link,
        title: text(i.title),
        link,
        publishedAt: toIso(text(i.pubDate)),
        summary: text(i.description),
      };
    });
  }

  return [];
}

/**
 * Which entries are new, and what the cursor becomes.
 *
 * Identity, not time, decides: feeds are not reliably ordered, entries get
 * edited and republished, and some omit dates entirely. `seenKeys` is a
 * bounded rolling window; `routine_deliveries` is the durable backstop.
 *
 * With no cursor this is a **baseline** run: nothing is new. Without that rule
 * the first tick dumps every entry in the feed into the user's Slack.
 */
export function diffItems(
  items: FeedItem[],
  cursor: Cursor | null,
  maxPerRun: number = DEFAULT_MAX_PER_RUN,
): { newItems: FeedItem[]; nextCursor: Cursor; overflow: number } {
  const newestFirst = [...items].sort((a, b) => {
    if (a.publishedAt && b.publishedAt) return b.publishedAt.localeCompare(a.publishedAt);
    if (a.publishedAt) return -1;
    if (b.publishedAt) return 1;
    return 0;
  });

  const seen = new Set(cursor?.seenKeys ?? []);
  const unseen = cursor === null ? [] : newestFirst.filter((i) => !seen.has(i.key));

  const newItems = unseen.slice(0, maxPerRun);
  const overflow = unseen.length - newItems.length;

  // Everything observed this round is marked seen, including entries dropped by
  // the cap — a burst should not be re-delivered piecemeal on later runs.
  const nextSeen = [...newestFirst.map((i) => i.key), ...(cursor?.seenKeys ?? [])];
  // Everything observed this round must stay in the window, even the items the
  // per-run cap declined to deliver — otherwise they resurface as "new" later.
  const windowSize = Math.max(SEEN_LIMIT, newestFirst.length);
  const dedupedSeen = [...new Set(nextSeen)].slice(0, windowSize);

  const dates = newestFirst.map((i) => i.publishedAt).filter((d): d is string => d !== null);

  return {
    newItems,
    overflow,
    nextCursor: {
      seenKeys: dedupedSeen,
      lastPublishedAt: dates[0] ?? cursor?.lastPublishedAt ?? null,
      etag: cursor?.etag ?? null,
      contentHash: cursor?.contentHash ?? null,
    },
  };
}
