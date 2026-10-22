import type { SupabaseClient } from "@supabase/supabase-js";
import type { Bindings } from "../../types";
import type { DocStore } from "../docstore";
import { getDocStore } from "../docstore";
import { serviceClient, userClient } from "../supabase";
import { mintDeferredToken } from "../api-keys";
import { canSendEmail, sendEmail } from "../email";
import { exportReadyEmail } from "../emails/export";
import { collectWorkspace, ExportFailure } from "./collect";
import { archiveEntries } from "./archive";
import { writeZip } from "./zip";

/**
 * Prepares the exports admins asked for (0132), one per tick.
 *
 * Read as the person who asked — a short token in their name, held to this
 * workspace — so the archive is their view of it, exactly as the download
 * that streams while you wait is (`routes/export.ts`). Written to the
 * document store in parts, kept seven days, and then deleted by the purge.
 */

export const EXPORT_LIFETIME_DAYS = 7;
/** Every part but the last the same size, as R2 requires. */
export const PART_SIZE = 8 * 1024 * 1024;

/** Where an export's file lives. Derived, so the download needs no column for it. */
export function exportObjectKey(workspaceId: string, exportId: string): string {
  return `exports/${workspaceId}/${exportId}.zip`;
}

export type ExportJobDeps = {
  /** The engine's: the claim, the requester's address, the row's outcome. */
  db: SupabaseClient;
  store: DocStore;
  /** A client in the requester's name, for this workspace. */
  asRequester: (
    user: { id: string; email: string | null },
    workspaceId: string,
  ) => Promise<SupabaseClient>;
  mail: ((email: ReturnType<typeof exportReadyEmail>) => Promise<void>) | null;
  appUrl: string;
  now: () => Date;
};

type ClaimedExport = { id: string; workspace_id: string; requested_by: string | null };

export async function runExportJobs(env: Bindings): Promise<{ prepared: number }> {
  // Without the JWT secret nothing can read as the requester, and reading as
  // anybody else is not an export of what they could see. The download that
  // streams still works on such an install.
  if (!env.SUPABASE_JWT_SECRET) return { prepared: 0 };
  let store: DocStore;
  try {
    store = getDocStore(env);
  } catch {
    return { prepared: 0 };
  }
  const secret = env.SUPABASE_JWT_SECRET;
  return runExportJobsWith({
    db: serviceClient(env),
    store,
    asRequester: async (user, workspaceId) =>
      userClient(env, await mintDeferredToken(secret, user, workspaceId)),
    mail: canSendEmail(env)
      ? async (email) => {
          await sendEmail(email, {
            fetchImpl: fetch.bind(globalThis),
            apiKey: env.RESEND_API_KEY!,
            from: env.RESEND_FROM!,
          });
        }
      : null,
    appUrl: (env.ALLOWED_ORIGIN ?? "").split(",")[0]!.trim(),
    now: () => new Date(),
  });
}

export async function runExportJobsWith(deps: ExportJobDeps): Promise<{ prepared: number }> {
  const { data, error } = await deps.db.rpc("claim_due_workspace_exports", { p_limit: 1 });
  if (error) {
    console.error("export: could not claim", error.code);
    return { prepared: 0 };
  }
  let prepared = 0;
  for (const row of (data ?? []) as ClaimedExport[]) {
    if (await prepareExport(row, deps)) prepared++;
  }
  return { prepared };
}

/** One export, start to finish. Never throws: every way it fails is a sentence on the row. */
export async function prepareExport(row: ClaimedExport, deps: ExportJobDeps): Promise<boolean> {
  const key = exportObjectKey(row.workspace_id, row.id);
  let uploadId: string | null = null;
  try {
    if (!row.requested_by) throw new Refusal("the person who asked for it has left");
    const { data: found } = await deps.db.auth.admin.getUserById(row.requested_by);
    const user = found?.user;
    if (!user) throw new Refusal("the person who asked for it has left");

    const db = await deps.asRequester({ id: user.id, email: user.email ?? null }, row.workspace_id);
    const { data: membership } = await db
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", row.workspace_id)
      .eq("user_id", user.id)
      .maybeSingle();
    // Asked as an admin; prepared only for one still.
    if (membership?.role !== "admin") throw new Refusal("whoever asked is no longer an admin here");
    const { data: workspace } = await db
      .from("workspaces")
      .select("id, name")
      .eq("id", row.workspace_id)
      .maybeSingle();
    if (!workspace) throw new Refusal("the workspace is gone");

    const tables = await collectWorkspace(db, row.workspace_id);
    const zip = writeZip(
      archiveEntries({
        workspace: { id: String(workspace.id), name: String(workspace.name) },
        exportedBy: { userId: user.id, role: "admin" },
        exportedAt: deps.now().toISOString(),
        tables,
        store: deps.store,
      }),
    );

    uploadId = await deps.store.createMultipart(key, { contentType: "application/zip" });
    const size = await uploadInParts(zip, deps.store, key, uploadId);
    uploadId = null;

    const finished = deps.now();
    const expires = new Date(finished.getTime() + EXPORT_LIFETIME_DAYS * 24 * 60 * 60_000);
    const { error } = await deps.db
      .from("workspace_exports")
      .update({
        status: "ready",
        object_key: key,
        size_bytes: size,
        error: null,
        claimed_at: null,
        finished_at: finished.toISOString(),
        expires_at: expires.toISOString(),
      })
      .eq("id", row.id);
    if (error) throw new Error(`could not record the export: ${error.message}`);

    if (deps.mail && user.email) {
      try {
        await deps.mail(
          exportReadyEmail({
            email: user.email,
            workspaceName: String(workspace.name),
            sizeBytes: size,
            expiresOn: expires.toISOString().slice(0, 10),
            url: `${deps.appUrl}/settings/export?download=${row.id}`,
          }),
        );
      } catch (err) {
        console.error("export: the ready mail did not go", err);
      }
    }
    return true;
  } catch (err) {
    if (uploadId) await deps.store.abortMultipart(key, uploadId).catch(() => {});
    const reason =
      err instanceof Refusal
        ? err.message
        : err instanceof ExportFailure
          ? `could not read ${err.table}`
          : "the export could not be prepared";
    if (!(err instanceof Refusal)) console.error("export: preparation failed", row.id, err);
    const { error } = await deps.db
      .from("workspace_exports")
      .update({
        status: "failed",
        error: reason,
        claimed_at: null,
        finished_at: deps.now().toISOString(),
      })
      .eq("id", row.id);
    if (error) console.error("export: could not record the failure", row.id, error.code);
    return false;
  }
}

/** A reason that is the requester's situation, not a fault: said, not logged. */
class Refusal extends Error {}

/**
 * Streams the zip into the store in equal parts, holding at most one part
 * plus one chunk in memory. Returns the archive's size.
 */
export async function uploadInParts(
  stream: ReadableStream<Uint8Array>,
  store: DocStore,
  key: string,
  uploadId: string,
  partSize: number = PART_SIZE,
): Promise<number> {
  const reader = stream.getReader();
  const parts: Awaited<ReturnType<DocStore["uploadPart"]>>[] = [];
  let buffer = new Uint8Array(partSize);
  let filled = 0;
  let total = 0;

  const flush = async (length: number) => {
    const body = buffer.slice(0, length).buffer;
    parts.push(await store.uploadPart(key, uploadId, parts.length + 1, body));
    filled = 0;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    let offset = 0;
    total += value.length;
    while (offset < value.length) {
      const take = Math.min(partSize - filled, value.length - offset);
      buffer.set(value.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === partSize) {
        await flush(partSize);
        buffer = new Uint8Array(partSize);
      }
    }
  }
  if (filled > 0 || parts.length === 0) await flush(filled);
  await store.completeMultipart(key, uploadId, parts);
  return total;
}
