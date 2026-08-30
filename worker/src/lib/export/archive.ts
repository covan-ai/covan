import type { DocStore } from "../docstore";
import type { Collected, Row } from "./collect";
import { renderSql } from "./sql";
import { EXCLUDED } from "./tables";
import type { ZipEntry } from "./zip";

/**
 * What goes in the archive, in the order it is written.
 *
 * A generator rather than a list, because the documents are the large part and
 * fetching them all up front would hold a whole workspace in memory to write it
 * one entry at a time. Each is read when the writer is ready for it and dropped
 * immediately after.
 */

export type ArchiveContext = {
  workspace: { id: string; name: string };
  exportedBy: { userId: string; role: string };
  exportedAt: string;
  tables: Collected;
  store: DocStore;
};

const encoder = new TextEncoder();
const json = (name: string, value: unknown): ZipEntry => ({
  name,
  data: encoder.encode(JSON.stringify(value, null, 2) + "\n"),
});

/**
 * A filename that survives being written to a disk.
 *
 * Prefixed with the row id because two documents in one workspace may share a
 * name, and an archive where the second silently replaces the first is a
 * backup that loses a file. Separators and control characters go, so an
 * uploaded name can never place an entry outside `documents/` — the archive is
 * extracted by whoever receives it, and a `../` in a zip entry is the oldest
 * trick there is.
 */
export function documentEntryName(id: string, name: string): string {
  const safe = String(name)
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\\u0000-\u001f]/g, "_")
    // `..` goes too, though by now it could not walk anywhere. It is for the
    // person reading an archive listing, who should not have to work out
    // whether a `..` in an entry name is dangerous before deciding it is not.
    .replace(/\.\./g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 120);
  return `documents/${id}-${safe || "document"}`;
}

const RESTORE_SH = `#!/bin/sh
# Put this workspace back into a Covan you control.
#
#   ./restore.sh "postgres://..." "<the user id it should belong to>" [DOCS_DIR]
#
# The first two arguments are required. The third is where the API keeps
# uploaded documents — DOCS_DIR in a compose stack; leave it out and the rows
# are restored without their files, which is a workspace that lists documents
# it cannot open.
#
# On Cloudflare the third step is an R2 upload instead; see docs/export.md.
set -eu

DB="\${1:?usage: restore.sh <database-url> <owner-user-id> [docs-dir]}"
OWNER="\${2:?usage: restore.sh <database-url> <owner-user-id> [docs-dir]}"
DOCS="\${3:-}"

# One transaction, so a failure leaves the database as it was. ON_ERROR_STOP is
# what makes psql treat the first error as fatal rather than carrying on and
# reporting success at the end.
psql "$DB" -v ON_ERROR_STOP=1 -v owner="'$OWNER'" -f workspace.sql

if [ -n "$DOCS" ]; then
  # The keys are in data/documents.json, and the files here are named
  # <id>-<original name>. Copying them under their stored key is what makes the
  # rows resolve.
  echo "Documents are in documents/. Their storage keys are the r2_key column"
  echo "in data/documents.json — copy each file to \\$DOCS/<r2_key>."
  echo "docs/export.md has a one-liner for it."
fi

echo "Restored. Run POST /admin/backfill-embeddings to rebuild retrieval."
`;

export async function* archiveEntries(ctx: ArchiveContext): AsyncGenerator<ZipEntry> {
  const { sql, droppedReferences } = renderSql(ctx.tables);
  const documents = (ctx.tables.documents ?? []) as Row[];
  const missing: { id: string; name: string; reason: string }[] = [];

  yield json("manifest.json", {
    format: 1,
    product: "covan",
    exportedAt: ctx.exportedAt,
    workspace: ctx.workspace,
    exportedBy: ctx.exportedBy,
    // Said first because it is the thing most likely to be assumed wrong. An
    // export is a read, so it holds what this person could see — not what the
    // workspace holds.
    scope:
      `Row level security decided what is in here. These are the rows visible to ` +
      `${ctx.exportedBy.userId}, whose role in the workspace was "${ctx.exportedBy.role}". ` +
      `An export taken by somebody else is a different file.`,
    restore:
      `workspace.sql replays every table below into a fresh Covan, in one transaction. ` +
      `Every person in the original workspace collapses to the single account you pass as ` +
      `the "owner" argument — accounts cannot be carried between installs, and inventing ` +
      `them for people who did not ask would be worse than saying so.`,
    counts: Object.fromEntries(Object.entries(ctx.tables).map(([t, rows]) => [t, rows.length])),
    excluded: EXCLUDED,
    droppedReferences,
    afterRestore:
      `Retrieval will not work until the chunks are rebuilt: POST /admin/backfill-embeddings ` +
      `with the new install's ADMIN_API_KEY. Delivery channels come back without their ` +
      `secrets — the ciphertext is bound to the old install's ROUTINE_SECRET_KEY — so any ` +
      `routine that posts to Slack or a webhook needs its credential entered again.`,
  });

  yield { name: "workspace.sql", data: encoder.encode(sql) };
  yield { name: "restore.sh", data: encoder.encode(RESTORE_SH) };

  for (const [table, rows] of Object.entries(ctx.tables)) {
    yield json(`data/${table}.json`, rows);
  }

  for (const row of documents) {
    const id = String(row.id ?? "");
    const name = String(row.name ?? "document");
    const key = typeof row.r2_key === "string" ? row.r2_key : "";
    if (!key) {
      missing.push({ id, name, reason: "the row has no stored file" });
      continue;
    }

    let object;
    try {
      object = await ctx.store.get(key);
    } catch (e) {
      console.error("export: document store read failed", key, e);
      missing.push({ id, name, reason: "the document store could not be read" });
      continue;
    }
    if (!object) {
      missing.push({ id, name, reason: "the stored file is gone" });
      continue;
    }

    yield { name: documentEntryName(id, name), data: new Uint8Array(await object.arrayBuffer()) };
  }

  // Last, because it cannot be written until every document has been tried.
  // Always written, even empty: an archive where the absence of a warnings file
  // means "no warnings" and a truncated download also means "no warnings" is an
  // archive that cannot tell you which one you have.
  yield json("data/export-warnings.json", { missingDocuments: missing });
}
