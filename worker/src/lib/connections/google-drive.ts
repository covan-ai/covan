import {
  errorForStatus,
  FileSkip,
  ProviderError,
  type ConnectionProvider,
  type ProviderContext,
  type FileRead,
  type ProviderEnv,
  type RemoteFile,
  type TokenEnvelope,
} from "./types";
import { decodeFileText, extOf, MAX_DIRECT_UPLOAD_BYTES, MAX_INDEX_CHARS } from "../extract";
import { extractFromBytes, UnreadableFile } from "../formats/read";
import { htmlToText } from "../formats/read/text";
import { pdfText } from "../formats/read/pdf";

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
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
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
 * The largest file a sync reads: the one-request upload's ceiling.
 *
 * Not the 100 MB a file uploaded in parts may be. An upload hands its file to
 * the indexing job; a sync still embeds what it reads inside its own run, five
 * files to a tick, so it keeps the size that was safe for that.
 */
const MAX_BYTES = MAX_DIRECT_UPLOAD_BYTES;

const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * A pointer to a file that lives somewhere else.
 *
 * "Add shortcut to Drive" is how a person puts a document from a shared drive
 * into the folder they actually work in, so in a real team folder these are
 * ordinary and often most of what is there. Drive returns them as files of
 * their own with this type, and the first version of this file had no case for
 * it: `importableName` returned null and every one of them was skipped without
 * a word. A folder of shortcuts synced as an empty bundle.
 */
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

/**
 * How many shortcuts one listing may resolve.
 *
 * A shortcut carries its target's id and type but not its `modifiedTime`, and
 * the modified time is the whole of how this sync decides a file has changed —
 * using the shortcut's own would mean edits to the target never re-imported it.
 * So each one costs a metadata request, and this bounds that. Past it the
 * listing reports itself truncated, the same as any other ceiling here.
 *
 * A shortcut to a *folder* costs nothing: its target id is all the walk needs.
 */
const MAX_SHORTCUTS = 25;

/**
 * How a Google-native file becomes text, and what it is called afterwards.
 *
 * The extension is chosen to match what the export actually produces, because
 * `lib/extract` reads the name on reindex: a Sheet exported as CSV and named
 * `.md` would be re-chunked later as if the commas were prose.
 *
 * `binary` marks an export that is a file to read rather than text already.
 */
const NATIVE_EXPORTS: Record<string, { mimeType: string; extension: string; binary?: boolean }> = {
  "application/vnd.google-apps.document": { mimeType: "text/markdown", extension: "md" },
  // As a workbook, so every tab comes with it. It used to be CSV, which Drive
  // only produces for the first tab — a budget's summary without the months
  // it summarises. The workbook is read the way an uploaded `.xlsx` is, one
  // section per sheet, and the citation still opens the Sheet in Drive.
  "application/vnd.google-apps.spreadsheet": {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
    binary: true,
  },
  "application/vnd.google-apps.presentation": { mimeType: "text/plain", extension: "txt" },
};

/**
 * Files whose text has to be read out of them: Office, OpenDocument, RTF and
 * PDF, read the way an upload is (`lib/formats/read`). The file itself is kept
 * as well as its text (`FileRead.original`), so it downloads as what it is.
 *
 * PDFs used to be absent, on the note that pdf.js does not run on the server.
 * It does — see `lib/formats/read/pdf.ts` — and a PDF with no text layer is read
 * by Claude when the deployment has a key, the same as an upload.
 *
 * The Office 97-2003 formats were listed as not imported, with advice to
 * re-save them, until `lib/formats/read` learned to read compound files. A
 * team's Drive that goes back twenty years is mostly them.
 */
const BINARY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
};

/**
 * Ordinary files that are already text, beyond `text/*`.
 *
 * Every `text/*` type is read as text — Drive types a Python file `text/x-python`
 * and a log `text/plain`, and both are prose to a reader. These are the text
 * formats that Drive files under `application/` instead.
 */
const TEXT_APPLICATION_MIME = new Set([
  "application/json",
  "application/ld+json",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-typescript",
  "application/sql",
  "application/x-sql",
  "application/x-sh",
  "application/x-httpd-php",
  "application/x-tex",
  "application/x-subrip",
]);

function isTextMime(mimeType: string): boolean {
  return (
    (mimeType.startsWith("text/") && !BINARY_MIME[mimeType]) || TEXT_APPLICATION_MIME.has(mimeType)
  );
}

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  size?: string;
  /** Present only on a shortcut, and the only thing that makes one useful. */
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
};

function withExtension(name: string, extension: string): string {
  return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

/** Whether this file can become text at all, and under what name. */
export function importableName(file: DriveFile): string | null {
  const native = NATIVE_EXPORTS[file.mimeType];
  if (native) return withExtension(file.name, native.extension);
  const binary = BINARY_MIME[file.mimeType];
  if (binary) return withExtension(file.name, binary);
  if (isTextMime(file.mimeType)) return file.name;
  return null;
}

/**
 * Why a file Drive lists is not imported. Always an answer.
 *
 * It used to be one only for PDFs, and every other file was dropped from the
 * listing without a word — a folder of `.doc` files synced as an empty bundle
 * and a run that said nothing had changed, which is how the first Drive folder
 * connected to covan.app looked. Now each file the sync leaves behind is named
 * on the run with one of these, and the Integrations page shows it.
 */
function notImportedBecause(file: DriveFile): string {
  const mime = file.mimeType;
  if (mime.startsWith("image/")) return "an image — Covan reads text, not pictures";
  if (mime.startsWith("video/")) return "a video";
  if (mime.startsWith("audio/")) return "an audio file";
  if (mime === "application/vnd.google-apps.drawing") return "a Google Drawing";
  if (mime === "application/vnd.google-apps.form") {
    return "a Google Form — its responses sheet can be synced instead";
  }
  if (mime.startsWith("application/vnd.google-apps.")) {
    return "a kind of Google file that cannot be exported as text";
  }
  if (/zip|compressed|x-tar|x-7z|x-rar|gzip/.test(mime))
    return "an archive — unzip it into the folder";
  return `a file type Covan cannot read (${mime || "unknown"})`;
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

/**
 * What a shortcut points at, as though it had been in the folder itself.
 *
 * The target's own metadata, not the shortcut's: its name, its type, and above
 * all its `modifiedTime`, which is what tells the next sync the document has
 * been edited. Returning null — the target is gone, or is a type nothing can
 * read — is an ordinary outcome and means the shortcut is skipped, exactly as a
 * file of that type in the folder would have been.
 */
async function resolveShortcut(
  ctx: ProviderContext,
  shortcut: DriveFile,
): Promise<DriveFile | null> {
  const targetId = shortcut.shortcutDetails?.targetId;
  if (!targetId) return null;

  const res = await driveFetch(ctx, `/files/${targetId}`, {
    fields: "id,name,mimeType,modifiedTime,webViewLink,size",
    supportsAllDrives: "true",
  });
  const target = (await res.json()) as DriveFile;
  return target.id ? target : null;
}

/** Everything under one folder, following subfolders, within the request budget. */
async function listTree(
  ctx: ProviderContext,
  rootId: string,
): Promise<{ files: DriveFile[]; truncated: boolean }> {
  const files: DriveFile[] = [];
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  // Shortcuts are resolved after the walk rather than during it, so a folder
  // full of them cannot spend the listing budget before the walk has seen the
  // rest of the tree.
  const shortcuts: DriveFile[] = [];
  // A shortcut and its target can both be in the tree, and after resolution
  // they are the same file with the same id. Importing it twice would be two
  // documents of one thing on the first sync and a fight over one row on every
  // sync after, since `documents` is unique on (connection_id, external_id).
  const seen = new Set<string>();
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
        fields:
          "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,size," +
          "shortcutDetails(targetId,targetMimeType))",
        pageSize: "100",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      };
      if (pageToken) query.pageToken = pageToken;

      const res = await driveFetch(ctx, "/files", query);
      const data = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };

      for (const file of data.files ?? []) {
        if (file.mimeType === SHORTCUT_MIME) {
          // A shortcut to a folder needs nothing fetched: the walk only wants an
          // id, and the folder's own listing supplies everything about what is
          // inside it.
          if (file.shortcutDetails?.targetMimeType === FOLDER_MIME) {
            const targetId = file.shortcutDetails.targetId;
            if (!targetId) continue;
            if (depth < MAX_FOLDER_DEPTH) queue.push({ id: targetId, depth: depth + 1 });
            else truncated = true;
            continue;
          }
          shortcuts.push(file);
          continue;
        }

        if (file.mimeType === FOLDER_MIME) {
          if (depth < MAX_FOLDER_DEPTH) queue.push({ id: file.id, depth: depth + 1 });
          else truncated = true;
          continue;
        }

        if (seen.has(file.id)) continue;
        seen.add(file.id);
        files.push(file);
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }

  // Their own budget rather than the listing one. A tree big enough to spend
  // all six listing requests would otherwise drop every shortcut in it, and
  // these are metadata reads of one file each — far cheaper than the page
  // listings that ceiling exists to bound.
  let resolved = 0;
  for (const shortcut of shortcuts) {
    const targetId = shortcut.shortcutDetails?.targetId;
    // The target is already in this tree: somebody put both the file and a
    // shortcut to it in the folder, which is not rare and is not two documents.
    if (!targetId || seen.has(targetId)) continue;
    if (resolved >= MAX_SHORTCUTS) {
      truncated = true;
      break;
    }
    resolved++;

    const target = await resolveShortcut(ctx, shortcut);
    if (!target || seen.has(target.id)) continue;
    seen.add(target.id);
    files.push(target);
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

  // Revoking the refresh token ends the whole grant, access tokens included.
  async revoke(_env, token, fetchImpl) {
    const res = await fetchImpl(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: token.refreshToken ?? token.accessToken }),
    });
    // 400 is Google saying the token is already invalid, which is the outcome
    // wanted anyway.
    if (!res.ok && res.status !== 400) {
      throw errorForStatus("Google", res.status, await res.text().catch(() => ""));
    }
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
      if (!name) {
        out.push({
          externalId: file.id,
          name: file.name,
          version: file.modifiedTime ?? "",
          url: file.webViewLink ?? null,
          skipReason: notImportedBecause(file),
        });
        continue;
      }
      const size = file.size ? Number(file.size) : 0;
      const tooLarge = Number.isFinite(size) && size > MAX_BYTES;
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
        ...(tooLarge ? { skipReason: "larger than 10 MB" } : {}),
      });
    }
    return out;
  },

  async readFile(ctx: ProviderContext, file: RemoteFile): Promise<string | FileRead> {
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
      if (exported.ok && native.binary) {
        const bytes = new Uint8Array(await exported.arrayBuffer());
        return { text: await readOutOf(file.name, bytes), original: bytes };
      }
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
      const body = await exported.text().catch(() => "");
      // A 403 on an export is about this file, not the grant: the listing that
      // found it a moment ago used the same token. Drive says so in the reason.
      if (exported.status === 403 && /exportSizeLimitExceeded|cannotExportFile/.test(body)) {
        throw new FileSkip("Google Drive will not export it (too large to export)");
      }
      throw errorForStatus("Google Drive", exported.status, body);
    }

    const download = await driveFetch(ctx, `/files/${file.externalId}`, {
      alt: "media",
      supportsAllDrives: "true",
    });
    const bytes = await download.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES) {
      throw new FileSkip("larger than 10 MB");
    }
    const ext = extOf(file.name);
    if (ext === "html" || ext === "htm") return htmlToText(decodeFileText(bytes));
    if (Object.values(BINARY_MIME).includes(ext)) {
      const original = new Uint8Array(bytes);
      return { text: await readOutOf(file.name, original), original };
    }
    return decodeFileText(bytes);
  },
};

/**
 * The text inside a file that is not text: a PDF's text layer, or what
 * `lib/formats/read` reads out of an Office or OpenDocument file. A file that
 * is not what its name says is this file's problem, named on the run.
 */
async function readOutOf(name: string, bytes: Uint8Array): Promise<string> {
  try {
    if (extOf(name) === "pdf") return (await pdfText(bytes, MAX_INDEX_CHARS)).text;
    return (await extractFromBytes(name, bytes, MAX_INDEX_CHARS))?.text ?? "";
  } catch (err) {
    if (err instanceof UnreadableFile) throw new FileSkip(err.message);
    throw err;
  }
}
