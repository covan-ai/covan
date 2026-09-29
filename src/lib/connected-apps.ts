import type { Connection, ProviderId, ToolConnection } from "./connections-api";

/**
 * The applications a workspace has actually wired up, as one list.
 *
 * Covan connects to other people's software twice over and the two halves know
 * nothing about each other. A `ToolConnection` with `transport: "composio"` is
 * something an agent CALLS — a grant living at Composio, identified by a
 * toolkit slug, wearing a mark we fetch through our own API. A `Connection` is
 * a source we RECONCILE — Notion or Drive, identified by a provider id,
 * wearing a mark we drew ourselves in `brand-marks.tsx`.
 *
 * A person does not experience two halves. They connected Notion, and the chat
 * screen should be able to say so once.
 */
export type ConnectedApp = {
  /** Normalised identity. What `appStartersFor` looks a sentence up by. */
  slug: string;
  /** What to call it on screen — the product, not the row. */
  name: string;
  /** A path on our API, for a mark we fetch. Empty when `provider` is set. */
  logoPath: string;
  /** Set when we hold the mark ourselves. Null when `logoPath` carries it. */
  provider: ProviderId | null;
};

/**
 * The same application, under the two names the two systems give it.
 *
 * An explicit table rather than a transformation, because the two vocabularies
 * agree by coincidence rather than by rule: `notion` is `notion` in both, and
 * Composio's Drive slug is `googledrive` where ours is `google_drive`. A
 * `replace(/_/g, "")` would get both right today and would be a guess about
 * every provider added later.
 *
 * `notion` is verified against this repo's own fixtures. `googledrive` is
 * Composio's documented slug and IS NOT verified here — no response carrying
 * it has been recorded. If it is wrong the failure is visible rather than
 * silent: Drive appears twice on the empty screen, once per half, and the fix
 * is one line in this table plus the fixture that would have caught it.
 */
const COMPOSIO_SLUG: Record<ProviderId, string> = {
  notion: "notion",
  google_drive: "googledrive",
};

/**
 * What to call an application, where running the slug through a title-case
 * would lie.
 *
 * Deliberately short. Every entry here is a claim that we know a product's
 * name better than the person who connected it, and that is only true where
 * the slug has lost information — a space, an inner capital — that no rule can
 * put back. `gmail` needs no entry; `googledrive` does.
 */
const APP_NAME: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  googlecalendar: "Google Calendar",
  googledocs: "Google Docs",
  googledrive: "Google Drive",
  googlemeet: "Google Meet",
  googlesheets: "Google Sheets",
  hackernews: "Hacker News",
  hubspot: "HubSpot",
  linkedin: "LinkedIn",
  microsoftteams: "Microsoft Teams",
  onedrive: "OneDrive",
  pagerduty: "PagerDuty",
  youtube: "YouTube",
};

/**
 * What one row is called, in three branches.
 *
 * The slug reaches the screen more often than it looks like it should: the
 * worker falls back to it when nobody typed a label, so `label` legitimately
 * reads "gmail" on a row somebody connected and never named. Taking the label
 * first would print that.
 *
 * So: the product's name if we know it, then the person's own label if they
 * gave one, then the slug made presentable. The middle branch is what carries
 * the fifteen hundred applications no table could list.
 */
function appName(slug: string, label: string): string {
  const known = APP_NAME[slug];
  if (known) return known;
  if (label && label !== slug) return label;
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/**
 * Both halves, deduplicated, in a stable order.
 *
 * WHAT IS LEFT OUT, and why each is a claim the code could not back:
 *
 * - A `pending` grant, where somebody walked away from a consent screen. The
 *   starter built on it would produce a failing tool call as the first thing
 *   the agent ever did.
 * - A `failed` one, for the same reason with less ambiguity.
 * - An `http` or `sql` connection. They are a REST API and a Postgres: no
 *   mark, no product name, and nothing a generic sentence could truthfully say.
 * - A Drive that has never been pointed at a folder (`needsFolder`). The grant
 *   exists and nothing has synced, so an offer to search it describes an empty
 *   index — failure mode #1.
 *
 * A `paused` SOURCE is kept, which looks inconsistent beside `pending` and is
 * not. A pause stops new documents arriving; it does not un-index the ones
 * already read, and those are still quotable today.
 *
 * WHEN BOTH HALVES HAVE IT, COMPOSIO WINS. Not because it is better, but
 * because the reconciler's contribution is already on the same screen: its
 * documents are what the Knowledge group above offers. A second, nearly
 * identical line would be repetition rather than coverage.
 */
export function mergeConnectedApps(tools: ToolConnection[], sources: Connection[]): ConnectedApp[] {
  const apps = new Map<string, ConnectedApp>();

  // Sources first, so a Composio row of the same slug overwrites rather than
  // being dropped — the precedence is stated once, here.
  for (const source of sources) {
    if (source.status !== "active" && source.status !== "paused") continue;
    if (source.needsFolder) continue;

    const slug = COMPOSIO_SLUG[source.provider];
    apps.set(slug, {
      slug,
      name: appName(slug, ""),
      logoPath: "",
      provider: source.provider,
    });
  }

  for (const tool of tools) {
    if (tool.transport !== "composio") continue;
    if (tool.status !== "active") continue;
    if (!tool.toolkitSlug) continue;

    const slug = tool.toolkitSlug;
    apps.set(slug, {
      slug,
      name: appName(slug, tool.label),
      logoPath: tool.logoPath,
      provider: null,
    });
  }

  return [...apps.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}
