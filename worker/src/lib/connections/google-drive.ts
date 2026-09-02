import {
  errorForStatus,
  ProviderError,
  type ConnectionProvider,
  type ProviderContext,
  type ProviderEnv,
  type RemoteFile,
  type TokenEnvelope,
} from "./types";

/**
 * Google Drive, as a source of documents.
 *
 * Where Notion hands us a scope, Drive hands us everything the person can read
 * and expects us to choose. So a Drive connection is made in two steps: the
 * grant, and then a folder — and it stays paused between them, because a
 * connection that defaulted to "all of My Drive" would be a product that
 * quietly embedded somebody's tax return. `routes/connections.ts` is where the
 * second step is served from; this file only knows how to list and read.
 *
 * A note the operator has to read before offering this at all: `drive.readonly`
 * is one of Google's *restricted* scopes. An unverified OAuth client can use it
 * with up to 100 users and shows them an "unverified app" screen; going past
 * that needs Google's verification, which for a restricted scope includes a
 * third-party security assessment. `docs/integrations.md` says so plainly —
 * this is a cost with a lead time, not a checkbox, and it is the single biggest
 * difference between shipping Notion and shipping Drive.
 */

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * Read-only, and nothing else.
 *
 * `drive.file` — the narrow scope that needs no verification — only reaches
 * files the user picked through Google's own Picker widget, which cannot
 * express "this folder, and whatever appears in it later". A folder that syncs
 * is the entire feature, so the narrow scope does not do it.
 */
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/**
 * How early a token is treated as expired.
 *
 * Google's access tokens last an hour. Refreshing with five minutes to spare
 * costs one request and removes the class of failure where a token is valid
 * when the run starts and expired by the fourth document.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * How many listing requests one sync may spend.
 *
 * Drive is listed folder by folder — there is no "everything under here" query
 * — so a deep tree costs one request per folder per 100 items. The cap bounds
 * that: past it, the listing returns what it has, and `sync.ts` reports the
 * truncation rather than letting a folder tree quietly go half-indexed.
 */
const MAX_LIST_REQUESTS = 6;

/** How deep subfolders are followed. Two levels is a folder of folders of files. */
const MAX_FOLDER_DEPTH = 2;

/**
 * The upload ceiling from `routes/bundles.ts`, restated for the same reason.
 *
 * A document that arrives through a connection is the same kind of thing as one
 * that arrives through the upload form, and being allowed to be ten times
 * bigger because of how it got here would be an accident rather than a policy.
 */
const MAX_BYTES = 10 * 1024 * 1024;

const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * How a Google-native file becomes text, and what it is called afterwards.
 *
 * The extension is chosen to match what the export actually produces, because
 * `lib/extract` reads the name on reindex: a Sheet exported as CSV and named
 * `.md` would be re-chunked later as if the commas were prose.
 */
const NATIVE_EXPORTS: Record<string, { mimeType: string; extension: string }> = {
  "application/vnd.google-apps.document": { mimeType: "text/markdown", extension: "md" },
  // The first sheet only. Drive's CSV export has no way to say "every tab", and
  // the alternative — one document per tab — would make a citation point at a
  // file the person cannot find in Drive. Written down in docs/integrations.md
  // rather than left to be discovered.
  "application/vnd.google-apps.spreadsheet": { mimeType: "text/csv", extension: "csv" },
  "application/vnd.google-apps.presentation": { mimeType: "text/plain", extension: "txt" },
};

/**
 * Ordinary files that are already text.
 *
 * PDFs are deliberately absent. `lib/extract` returns "" for them — pdf.js does
 * not bundle for the Workers runtime, so the browser does that job at upload
 * time — and there is no browser in a cron tick. Importing them would produce
 * documents that are listed, named to the model, and impossible to retrieve a
 * sentence of, which `hasIndexableText` exists to prevent at upload and would
 * catch here too. Skipping them with a reason is the honest version.
 */
const READABLE_MIME = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/xml",
  "text/xml",
  "text/html",
]);

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  size?: string;
};

function withExtension(name: string, extension: string): string {
  return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

/** Whether this file can become text at all, and under what name. */
export function importableName(file: DriveFile): string | null {
  const native = NATIVE_EXPORTS[file.mimeType];
  if (native) return withExtension(file.name, native.extension);
  if (READABLE_MIME.has(file.mimeType)) return file.name;
  return null;
}

async function driveFetch(
  ctx: ProviderContext,
  path: string,
  query: Record<string, string>,
): Promise<Response> {
  const url = new URL(`${DRIVE_API}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await ctx.fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${ctx.token.accessToken}` },
  });
  if (!res.ok) throw errorForStatus("Google Drive", res.status, await res.text().catch(() => ""));
  return res;
}

/**
 * The folders directly inside one parent.
 *
 * Exported because the interface needs it: choosing a folder is step two of
 * connecting, and the browser cannot ask Drive itself without holding a token
 * we are deliberately not giving it.
 */
export async function listFolders(
  ctx: ProviderContext,
  parentId: string,
): Promise<Array<{ id: string; name: string }>> {
  const res = await driveFetch(ctx, "/files", {
    q: `'${parentId.replace(/'/g, "\\'")}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: "files(id,name)",
    pageSize: "100",
    orderBy: "name",
    // Shared drives are where a company's actual handbook lives; without these
    // two the picker shows an engineer their own empty My Drive and nothing
    // else.
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const data = (await res.json()) as { files?: Array<{ id: string; name: string }> };
  return data.files ?? [];
}

/** Everything under one folder, following subfolders, within the request budget. */
async function listTree(
  ctx: ProviderContext,
  rootId: string,
): Promise<{ files: DriveFile[]; truncated: boolean }> {
  const files: DriveFile[] = [];
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  let requests = 0;
  let truncated = false;

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    let pageToken: string | undefined;

    do {
      if (requests >= MAX_LIST_REQUESTS) return { files, truncated: true };
      requests++;

      const query: Record<string, string> = {
        q: `'${id.replace(/'/g, "\\'")}' in parents and trashed = false`,
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,size)",
        pageSize: "100",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      };
      if (pageToken) query.pageToken = pageToken;

      const res = await driveFetch(ctx, "/files", query);
      const data = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };

      for (const file of data.files ?? []) {
        if (file.mimeType === FOLDER_MIME) {
          if (depth < MAX_FOLDER_DEPTH) queue.push({ id: file.id, depth: depth + 1 });
          else truncated = true;
          continue;
        }
        files.push(file);
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }

  return { files, truncated };
}

/** The folder a connection is pointed at, or null while it is still being set up. */
export function folderIdOf(config: Record<string, unknown>): string | null {
  const id = config.folderId;
  return typeof id === "string" && id ? id : null;
}

export const googleDriveProvider: ConnectionProvider = {
  id: "google_drive",
  label: "Google Drive",

  isConfigured(env: ProviderEnv): boolean {
    return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  },

  authorizeUrl(env: ProviderEnv, state: string, redirectUri: string): string {
    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID ?? "");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPE);
    // Without both of these there is no refresh token, and a connection that
    // works for an hour and then needs a human is worse than one that never
    // worked: `access_type=offline` asks for one, and `prompt=consent` is what
    // makes Google issue it again for somebody who has granted this app before
    // — it only ever sends a refresh token on a fresh consent.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("state", state);
    return url.toString();
  },

  async exchangeCode(env, code, redirectUri, fetchImpl) {
    const res = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID ?? "",
        client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) {
      throw errorForStatus("Google", res.status, await res.text().catch(() => ""));
    }

    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) throw new ProviderError("Google returned no access token", false);
    if (!data.refresh_token) {
      // Refused rather than stored. A connection with no refresh token syncs
      // for an hour and then fails forever, and the failure arrives days later
      // with no obvious cause — the usual reason being a previous grant that
      // was never revoked, which `prompt=consent` above is meant to prevent.
      throw new ProviderError(
        "Google did not return a refresh token, so this connection could not keep working " +
          "for more than an hour. Remove Covan from your Google account's third-party " +
          "access list and connect again.",
        false,
      );
    }

    const token: TokenEnvelope = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    };

    // Whose Drive this is. `about` works with the drive scopes we already have,
    // so it costs no extra consent — unlike the userinfo endpoint, which would
    // add an email scope to the screen for one label.
    let accountLabel = "Google Drive";
    try {
      const about = await fetchImpl(`${DRIVE_API}/about?fields=user(displayName,emailAddress)`, {
        headers: { Authorization: `Bearer ${token.accessToken}` },
      });
      if (about.ok) {
        const who = (await about.json()) as {
          user?: { displayName?: string; emailAddress?: string };
        };
        accountLabel = who.user?.emailAddress || who.user?.displayName || accountLabel;
      }
    } catch {
      // A label is not worth failing a grant over.
    }

    // No folder yet. The connection is created paused for exactly this reason,
    // and the interface's next screen is the folder picker.
    return { token, accountLabel, config: {} };
  },

  async refresh(env, token, fetchImpl) {
    if (!token.refreshToken) return token;
    if (token.expiresAt && token.expiresAt - Date.now() > REFRESH_MARGIN_MS) return token;

    const res = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID ?? "",
        client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
        refresh_token: token.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) {
      throw errorForStatus("Google", res.status, await res.text().catch(() => ""));
    }

    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new ProviderError("Google returned no access token", true);

    return {
      // Google does not re-issue the refresh token on a refresh, so the one we
      // already hold is carried forward. Dropping it here would turn every
      // refresh into the last one.
      refreshToken: token.refreshToken,
      accessToken: data.access_token,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    };
  },

  async listFiles(ctx: ProviderContext): Promise<RemoteFile[]> {
    const folderId = folderIdOf(ctx.config);
    if (!folderId) {
      throw new ProviderError(
        "This Drive connection has no folder yet — choose one from Integrations.",
        false,
      );
    }

    const { files } = await listTree(ctx, folderId);

    const out: RemoteFile[] = [];
    for (const file of files) {
      const name = importableName(file);
      if (!name) continue;
      const size = file.size ? Number(file.size) : 0;
      if (Number.isFinite(size) && size > MAX_BYTES) continue;
      out.push({
        externalId: file.id,
        name,
        // `modifiedTime` is Drive's own version marker and changes on every
        // edit, including ones that do not change the text. A sync that
        // re-embeds an unchanged document is a wasted allowance rather than a
        // wrong answer, and the alternative — hashing the content — costs a
        // download of every file on every run to find out.
        version: file.modifiedTime ?? "",
        url: file.webViewLink ?? null,
      });
    }
    return out;
  },

  async readFile(ctx: ProviderContext, file: RemoteFile): Promise<string> {
    // The listing already decided this file is importable; what it did not
    // carry is which of the two ways to read it. Re-read the one field that
    // decides, rather than widening RemoteFile with a provider-specific column.
    const res = await driveFetch(ctx, `/files/${file.externalId}`, {
      fields: "id,name,mimeType,size",
      supportsAllDrives: "true",
    });
    const meta = (await res.json()) as DriveFile;

    const native = NATIVE_EXPORTS[meta.mimeType];
    if (native) {
      const exported = await ctx.fetchImpl(
        `${DRIVE_API}/files/${file.externalId}/export?mimeType=${encodeURIComponent(native.mimeType)}`,
        { headers: { Authorization: `Bearer ${ctx.token.accessToken}` } },
      );
      if (exported.ok) return await exported.text();

      // Markdown export is comparatively new. A 400 means this Docs file cannot
      // produce it, which is a reason to ask for plain text rather than to fail
      // — the content is the same, only the headings are lost.
      if (exported.status === 400 && native.mimeType === "text/markdown") {
        const plain = await ctx.fetchImpl(
          `${DRIVE_API}/files/${file.externalId}/export?mimeType=text%2Fplain`,
          { headers: { Authorization: `Bearer ${ctx.token.accessToken}` } },
        );
        if (plain.ok) return await plain.text();
        throw errorForStatus("Google Drive", plain.status, await plain.text().catch(() => ""));
      }
      throw errorForStatus("Google Drive", exported.status, await exported.text().catch(() => ""));
    }

    const download = await driveFetch(ctx, `/files/${file.externalId}`, {
      alt: "media",
      supportsAllDrives: "true",
    });
    const bytes = await download.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES) {
      throw new ProviderError(`${file.name} is larger than 10 MB`, false);
    }
    return new TextDecoder().decode(bytes);
  },
};
