/**
 * Google Drive: a file added, or a file changed, in a folder the routine's
 * Drive connection can see.
 *
 * HOW DRIVE TELLS ANYBODY ANYTHING. A watch channel (`changes.watch`) makes
 * Drive POST to an address whenever something in the account changes — with
 * an empty body. The notification says only "look again"; what changed is
 * read with `changes.list` from a page token, and the list hands back the
 * token to read from next time. So each subscription is one channel, on the
 * connection's own grant, delivering to `/routine-events/drive/<channel id>`;
 * its `state` keeps the page token, and `advance` lists from it and moves it
 * (`receive.ts` writes the move, conditionally, so two notifications at once
 * do not both report the same change).
 *
 * WHAT A DELIVERY IS CHECKED FOR. The channel was made with a random token
 * of its own, which Drive sends back as `X-Goog-Channel-Token`; that is this
 * subscription's secret, and `authenticate` compares it before anything is
 * read. The channel id in the URL is random too.
 *
 * LEASES. A channel lasts at most a week and cannot be extended — Drive's
 * rule — so renewing is making a new channel and stopping the old one. The
 * sweeper does it a day before the old one ends (0109's
 * `claim_event_subscriptions`). Pausing stops the channel; resuming makes a
 * new one from a fresh page token, so changes made while paused are not
 * delivered all at once on Resume.
 *
 * WHAT COUNTS. Folders are not files here, and neither is anything trashed or
 * removed. "New" is a file whose creation and change are the same moment,
 * give or take a few minutes; everything else is "changed". A Google Doc
 * being typed into is saved, and so changes, every few minutes — the flood
 * fuse in `receive.ts` and the folder filter are what keep that sane.
 */

import { z } from "zod";
import type { RoutineEnv } from "../../../types";
import { textOf, type ProviderEnv, type TokenEnvelope } from "../../connections/types";
import { folderIdOf, googleDriveProvider, importableName } from "../../connections/google-drive";
import { base64url } from "../../jwt";
import { timingSafeEqual } from "../../hmac";
import type { AdapterContext, Advanced, EventAdapter, SubscribeResult } from "./adapter";
import type { EventTypeDef, NormalizedEvent } from "./catalog";
import { grantFor, type Grant, type GrantDeps } from "./connection-grant";
import { EventSourceError } from "./errors";
import { clip, lines, rec, str } from "./text";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** The shape of the id in a Drive channel URL. The route refuses anything else. */
export const DRIVE_CHANNEL_ID = /^dr_[A-Za-z0-9_-]{32}$/;

/** Drive's ceiling for a `changes` channel, less a minute of slack. */
const CHANNEL_MS = 7 * 24 * 60 * 60 * 1000 - 60_000;

/** How many pages of changes one notification may read. 100 changes a page. */
const MAX_CHANGE_PAGES = 5;

/** A creation this close to its change is a new file, not an edit. */
const NEW_WITHIN_MS = 5 * 60 * 1000;

/** The most files one run is told about. */
const MAX_FILES = 10;

/** What the receiving route hands over: Drive's headers. The body is empty. */
export type DriveNotification = {
  /** `X-Goog-Channel-Token`: the subscription's secret, sent back. */
  token: string;
  /** `X-Goog-Resource-State`: `sync` for the channel's first message. */
  state: string;
};

type DriveChange = {
  fileId?: string;
  time?: string;
  removed?: boolean;
  file?: {
    id?: string;
    name?: string;
    mimeType?: string;
    parents?: string[];
    createdTime?: string;
    modifiedTime?: string;
    webViewLink?: string;
    trashed?: boolean;
    lastModifyingUser?: { displayName?: string; emailAddress?: string };
  };
};

/** A folder id from a Drive link or an id. */
export function driveFolderIdOf(input: unknown): string | null {
  const value = str(input);
  if (!value) return null;
  const fromLink = value.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
  if (fromLink) return fromLink[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(value) ? value : null;
}

// ---- the entries ----------------------------------------------------------------

const REQUIRES = { kind: "connection", provider: "google_drive" } as const;

const driveConfig = z.object({
  folder: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v ? v : undefined)),
});

const FOLDER_FIELD = {
  key: "folder",
  label: "Only files in",
  kind: "text" as const,
  optional: true,
  placeholder: "The folder your connection syncs",
  help: "A folder's link. Empty means the folder your Google Drive connection syncs. Only files directly in the folder count.",
};

export type DriveEventSpec = {
  def: EventTypeDef;
  /** Which of the listed files this entry is about. */
  wants: (change: DriveChange) => boolean;
  happened: string;
};

function isNew(change: DriveChange): boolean {
  const created = Date.parse(str(change.file?.createdTime));
  const changed = Date.parse(str(change.time) || str(change.file?.modifiedTime));
  return (
    Number.isFinite(created) &&
    Number.isFinite(changed) &&
    Math.abs(changed - created) <= NEW_WITHIN_MS
  );
}

const SAMPLE = lines([
  ["File", "Supplier contract — Kestrel.pdf"],
  ["Kind", "PDF"],
  ["Link", "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view"],
  ["By", "Mert Kaya <mert@example.com>"],
]);

export const DRIVE_EVENTS: readonly DriveEventSpec[] = [
  {
    wants: isNew,
    happened: "Added",
    def: {
      id: "google_drive.new_file",
      provider: "google_drive",
      app: "Google Drive",
      label: "New file",
      description: "Runs shortly after a file is added to a Drive folder.",
      requires: REQUIRES,
      config: driveConfig,
      fields: [FOLDER_FIELD],
      sample: { eventId: "sample", text: `${SAMPLE}\nWhat happened: Added` },
    },
  },
  {
    wants: (change) => !isNew(change),
    happened: "Changed",
    def: {
      id: "google_drive.file_changed",
      provider: "google_drive",
      app: "Google Drive",
      label: "File changed",
      description: "Runs shortly after a file in a Drive folder is edited or replaced.",
      requires: REQUIRES,
      config: driveConfig,
      fields: [FOLDER_FIELD],
      sample: { eventId: "sample", text: `${SAMPLE}\nWhat happened: Changed` },
    },
  },
];

function driveSpec(type: string): DriveEventSpec | undefined {
  return DRIVE_EVENTS.find((s) => s.def.id === type);
}

// ---- the adapter -------------------------------------------------------------------

export type DriveAdapterDeps = GrantDeps & { fetchImpl?: typeof fetch; now?: () => number };

function publicOrigin(env: RoutineEnv): string | null {
  const host = env.WORKER_HOST?.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return host ? `https://${host}` : null;
}

function newChannelId(): string {
  return `dr_${base64url(crypto.getRandomValues(new Uint8Array(24)))}`;
}

function newSecret(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function driveAdapter(deps: DriveAdapterDeps = {}): EventAdapter {
  const fetchImpl: typeof fetch = deps.fetchImpl ?? fetch.bind(globalThis);
  const now = deps.now ?? Date.now;

  /** The grant with an access token that works now. Not stored back; see `connection-grant.ts`. */
  async function freshGrant(ctx: AdapterContext): Promise<Grant> {
    const grant = await grantFor(ctx, "google_drive", deps);
    let token: TokenEnvelope;
    try {
      token = await googleDriveProvider.refresh(
        ctx.env as RoutineEnv & ProviderEnv,
        grant.token,
        fetchImpl,
      );
    } catch {
      throw new EventSourceError(
        "Google Drive refused the connection. Connect it again, then choose this event again.",
        { expired: true },
      );
    }
    return { ...grant, token };
  }

  async function drive(
    token: string,
    path: string,
    init: RequestInit & { query?: Record<string, string> } = {},
  ): Promise<Response> {
    const url = new URL(`${DRIVE_API}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
    return fetchImpl(url.toString(), {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
  }

  /** A refusal Drive gave, as a sentence, or a throw worth another try. */
  async function refused(res: Response, doing: string): Promise<never> {
    const said = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
    if (res.status === 401 || res.status === 403) {
      throw new EventSourceError(
        "Google Drive refused the connection. Connect it again, then choose this event again.",
        { expired: true },
      );
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      throw new EventSourceError(`Google Drive refused to ${doing}${said ? `: ${said}` : "."}`);
    }
    throw new Error(`google drive ${doing} answered ${res.status}${said ? `: ${said}` : ""}`);
  }

  /** A new channel from `pageToken` (or from now), with `secret` (or a new one). */
  async function watch(
    ctx: AdapterContext,
    keep: { pageToken?: string; secret?: string },
  ): Promise<SubscribeResult> {
    const origin = publicOrigin(ctx.env);
    if (!origin)
      throw new EventSourceError("This deployment has no public address for Drive to call.");
    const grant = await freshGrant(ctx);
    const token = grant.token.accessToken;

    let pageToken = keep.pageToken;
    if (!pageToken) {
      const res = await drive(token, "/changes/startPageToken", {
        query: { supportsAllDrives: "true" },
      });
      if (!res.ok) await refused(res, "start watching");
      pageToken = str(rec(await res.json())?.startPageToken);
      if (!pageToken) throw new Error("google drive gave no start page token");
    }

    const id = newChannelId();
    const secret = keep.secret ?? newSecret();
    const expiration = now() + CHANNEL_MS;
    const res = await drive(token, "/changes/watch", {
      method: "POST",
      query: {
        pageToken,
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      },
      body: JSON.stringify({
        id,
        type: "web_hook",
        address: `${origin}/routine-events/drive/${id}`,
        token: secret,
        expiration: String(expiration),
      }),
    });
    if (!res.ok) await refused(res, "start watching");
    const channel = rec(await res.json()) ?? {};
    const granted = Number(str(channel.expiration));
    return {
      externalId: id,
      secret,
      state: { pageToken, resourceId: str(channel.resourceId) },
      expiresAt: new Date(Number.isFinite(granted) && granted > 0 ? granted : expiration),
    };
  }

  /** Stop the channel this row holds. Best effort: an unstopped one ends within a week. */
  async function stop(ctx: AdapterContext): Promise<void> {
    const id = ctx.subscription.external_id;
    const resourceId = str(rec(ctx.subscription.state)?.resourceId);
    if (!id || !resourceId) return;
    try {
      const grant = await freshGrant(ctx);
      const res = await drive(grant.token.accessToken, "/channels/stop", {
        method: "POST",
        body: JSON.stringify({ id, resourceId }),
      });
      // 404: Drive has already forgotten it, which is the outcome wanted.
      if (!res.ok && res.status !== 404) {
        console.error(`drive channel ${id} could not be stopped: ${res.status}`);
      }
    } catch (err) {
      console.error(`drive channel ${id} could not be stopped; it will lapse`, err);
    }
  }

  return {
    provider: "google_drive",

    isConfigured(env: RoutineEnv) {
      const oauth = env as RoutineEnv & ProviderEnv;
      return Boolean(oauth.GOOGLE_CLIENT_ID && oauth.GOOGLE_CLIENT_SECRET && publicOrigin(env));
    },

    // Kept where there is one: a retry after a failure goes on from the page
    // token the row already holds, and keeps the secret.
    async subscribe(ctx) {
      const state = rec(ctx.subscription.state);
      return watch(ctx, {
        pageToken: str(state?.pageToken) || undefined,
        secret: ctx.secret ?? undefined,
      });
    },

    // A channel cannot be extended: a new one, then the old one stopped, so
    // there is never a moment with neither.
    async renew(ctx) {
      const state = rec(ctx.subscription.state);
      const next = await watch(ctx, {
        pageToken: str(state?.pageToken) || undefined,
        secret: ctx.secret ?? undefined,
      });
      await stop(ctx);
      return next;
    },

    async unsubscribe(ctx) {
      await stop(ctx);
    },

    async setEnabled(ctx, enabled) {
      if (!enabled) {
        await stop(ctx);
        return;
      }
      // From now, not from where it stopped: see the module comment.
      return watch(ctx, { secret: ctx.secret ?? undefined });
    },

    async authenticate(raw, ctx) {
      const note = rec(raw) as DriveNotification | null;
      if (!ctx.secret || !note) return false;
      return timingSafeEqual(str(note.token), ctx.secret);
    },

    async advance(raw, ctx): Promise<Advanced | null> {
      const note = rec(raw) as DriveNotification | null;
      if (!note || str(note.state) === "sync") return null;
      const state = rec(ctx.subscription.state) ?? {};
      const from = str(state.pageToken);
      if (!from) return null;

      const grant = await freshGrant(ctx);
      const changes: DriveChange[] = [];
      let pageToken = from;
      let next = from;
      for (let page = 0; page < MAX_CHANGE_PAGES; page++) {
        const res = await drive(grant.token.accessToken, "/changes", {
          query: {
            pageToken,
            pageSize: "100",
            supportsAllDrives: "true",
            includeItemsFromAllDrives: "true",
            includeRemoved: "false",
            fields:
              "nextPageToken,newStartPageToken,changes(fileId,time,removed,file(id,name,mimeType,parents,createdTime,modifiedTime,webViewLink,trashed,lastModifyingUser(displayName,emailAddress)))",
          },
        });
        if (!res.ok) await refused(res, "list what changed");
        const body = rec(await res.json()) ?? {};
        if (Array.isArray(body.changes)) changes.push(...(body.changes as DriveChange[]));
        const more = str(body.nextPageToken);
        const fresh = str(body.newStartPageToken);
        if (fresh) {
          next = fresh;
          break;
        }
        if (!more) break;
        next = more;
        pageToken = more;
      }
      if (next === from && changes.length === 0) return null;
      return {
        raw: { changes, connectionFolder: folderIdOf(grant.config) },
        state: { ...state, pageToken: next },
        cursor: { key: "pageToken", from },
      };
    },

    async normalize(raw, ctx): Promise<NormalizedEvent | null> {
      const spec = driveSpec(ctx.subscription.event_type);
      const listed = rec(raw);
      if (!spec || !listed || !Array.isArray(listed.changes)) return null;
      const folder =
        driveFolderIdOf(ctx.subscription.config?.folder) ?? str(listed.connectionFolder) ?? "";

      // The latest change per file, then only the files this entry is about.
      const byFile = new Map<string, DriveChange>();
      for (const change of listed.changes as DriveChange[]) {
        const file = change.file;
        if (change.removed || !file?.id || file.trashed || file.mimeType === FOLDER_MIME) continue;
        if (folder && !(file.parents ?? []).includes(folder)) continue;
        byFile.set(file.id, change);
      }
      const chosen = [...byFile.values()].filter(spec.wants);
      if (chosen.length === 0) return null;

      const described = chosen.slice(0, MAX_FILES).map((change) => {
        const file = change.file!;
        const who = file.lastModifyingUser;
        return lines([
          ["File", str(file.name) || "(untitled)"],
          ["Kind", str(file.mimeType)],
          ["Link", str(file.webViewLink)],
          [
            "By",
            who?.displayName && who.emailAddress
              ? `${who.displayName} <${who.emailAddress}>`
              : str(who?.emailAddress) || str(who?.displayName),
          ],
          ["When", str(change.time) || str(file.modifiedTime)],
          ["What happened", spec.happened],
        ]);
      });
      if (chosen.length > MAX_FILES)
        described.push(`…and ${chosen.length - MAX_FILES} more files.`);

      // One file: what it says, too, read the way the connection's sync reads
      // it. Several: the list is the news, and reading each would be a run's
      // worth of requests before the run starts.
      let content = "";
      const only = chosen.length === 1 ? chosen[0].file! : null;
      // Only what the sync itself would read as text: a Doc, a Sheet, an
      // Office file, plain text. An image or a video is described, not read.
      const readable =
        only &&
        importableName({ id: only.id!, name: str(only.name), mimeType: str(only.mimeType) });
      if (only && readable) {
        try {
          const grant = await freshGrant(ctx);
          content = textOf(
            await googleDriveProvider.readFile(
              { token: grant.token, config: grant.config, fetchImpl },
              {
                externalId: only.id!,
                name: readable,
                version: str(only.modifiedTime),
                url: str(only.webViewLink) || null,
              },
            ),
          );
        } catch (err) {
          console.error(`drive event: could not read ${only.id}`, err);
        }
      }

      const keys = chosen
        .map((c) => `${c.file!.id}@${str(c.file!.modifiedTime) || str(c.time)}`)
        .sort()
        .join("\n");
      const text = described.join("\n\n---\n\n");
      return {
        eventId: `drive:${(await sha256Hex(keys)).slice(0, 32)}`,
        text: content ? `${text}\n\n${clip(content)}` : text,
        label:
          chosen.length === 1
            ? `Google Drive · ${spec.happened}: ${str(chosen[0].file!.name)}`.slice(0, 120)
            : undefined,
      };
    },
  };
}

export const DRIVE_ADAPTER = driveAdapter();
