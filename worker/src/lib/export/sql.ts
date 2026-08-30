import type { Collected, Row } from "./collect";
import { EXPORTED } from "./tables";

/**
 * The archive's restore path, rendered as SQL somebody can read before running.
 *
 * The alternative was an importer — a program that reads the JSON and writes
 * the rows. It would have been a second implementation of what Postgres already
 * does, needing its own dependency, its own errors and its own trust. A `.sql`
 * file needs `psql`, which anybody restoring a database has, and it can be
 * opened and read first, which is worth a great deal when the thing you are
 * about to run touches a database you care about.
 *
 * It is one transaction. A restore either happens or does not.
 */

/**
 * Columns that hold a person, and the reason the restore needs an argument.
 *
 * Every one of these ends at an account, and the accounts in a fresh install are
 * not the accounts in the old one — there is no id to carry across, and
 * inventing users for people who did not ask to be recreated would be worse
 * than not having them. So every person in the export collapses to whoever runs
 * the restore, and the archive says so plainly rather than appearing to have
 * preserved a team it did not.
 *
 * "Ends at an account" rather than "references auth.users", because one of them
 * does not, and that is exactly how it nearly got missed.
 */
export const USER_COLUMNS = new Set([
  "user_id",
  "created_by",
  "invited_by",
  "accepted_by",
  // `messages.sender_id` references `public.profiles` rather than
  // `auth.users`, which is why it is easy to miss in a search for the
  // latter — 0008 pointed it at profiles so PostgREST could embed the
  // sender. It is still a person, and profiles are not replayed, so
  // leaving it alone would dangle every message in the archive.
  "sender_id",
]);

/**
 * Not replayed: a profile belongs to an account, and the account restoring this
 * already has one. Exported as JSON anyway, because "who was Ayşe in these
 * messages" is a question the archive should still be able to answer.
 */
const SKIP = new Set(["profiles"]);

/**
 * Nullable references that can point outside what the caller could see.
 *
 * A member exporting a workspace gets the sessions they may read, so an idea
 * cited from a message in somebody else's private session arrives with a
 * dangling `source_message_id`. Restoring that row would fail the foreign key
 * and take the whole transaction with it. The reference is dropped instead, and
 * `manifest.json` counts what was dropped so the loss is stated rather than
 * discovered.
 */
const OPTIONAL_REFS: Record<string, string> = {
  "ideas.source_message_id": "messages",
  "routines.delivery_channel_id": "delivery_channels",
  "documents.agent_id": "agents",
};

/** A Postgres literal. `standard_conforming_strings` is on, so doubling `'` is enough. */
function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  // Objects and arrays are the three jsonb columns — messages.sources,
  // routines.source_config, routines.cursor. Postgres coerces the string
  // literal to jsonb because the target column's type is known.
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `'${text.replace(/'/g, "''")}'`;
}

export type RenderedSql = {
  sql: string;
  /** `table.column` → how many references were dropped as unreachable. */
  droppedReferences: Record<string, number>;
};

export function renderSql(tables: Collected): RenderedSql {
  const dropped: Record<string, number> = {};
  const known = new Map<string, Set<string>>();
  for (const [table, rows] of Object.entries(tables)) {
    known.set(table, new Set(rows.map((r) => String(r.id ?? "")).filter(Boolean)));
  }

  const out: string[] = [
    "-- workspace.sql — replay this workspace into a fresh Covan.",
    "--",
    "--   psql \"$DATABASE_URL\" -v owner='<the user id this should belong to>' \\",
    "--        -f workspace.sql",
    "--",
    "-- `owner` is required and psql stops if it is missing. Every person in the",
    "-- original workspace becomes that one account: see the archive's manifest.",
    "--",
    "-- Ids are preserved, so a restore is comparable to the export row for row,",
    "-- and the document filenames in documents/ still match their rows.",
    "--",
    "-- Written by Covan. Read it before you run it.",
    "",
    "begin;",
    "",
  ];

  for (const spec of EXPORTED) {
    if (SKIP.has(spec.table)) continue;
    const rows = rewriteForRestore(spec.table, tables[spec.table] ?? []);
    if (rows.length === 0) {
      out.push(`-- ${spec.table}: nothing to restore`, "");
      continue;
    }

    const columns = Object.keys(rows[0]);
    out.push(`-- ${spec.table} (${rows.length})`);
    for (const row of rows) {
      const values = columns.map((column) => {
        if (USER_COLUMNS.has(column)) return ":'owner'";

        const ref = OPTIONAL_REFS[`${spec.table}.${column}`];
        const value = row[column];
        if (ref && typeof value === "string" && !known.get(ref)?.has(value)) {
          const key = `${spec.table}.${column}`;
          dropped[key] = (dropped[key] ?? 0) + 1;
          return "NULL";
        }

        return literal(value);
      });

      out.push(
        `insert into public.${spec.table} (${columns.join(", ")}) values (${values.join(", ")}) on conflict do nothing;`,
      );
    }
    out.push("");
  }

  out.push("commit;", "");
  return { sql: out.join("\n"), droppedReferences: dropped };
}

/**
 * The value a restored delivery channel carries where its secret was.
 *
 * `delivery_channels.secret_ciphertext` is `not null`, and the export cannot
 * read it — 0023 withholds that column from `authenticated`, and it would be
 * undecryptable under another install's `ROUTINE_SECRET_KEY` even if it could.
 * So something has to go in the column, and this is it: deliberately not the
 * `v1.<iv>.<ct>` shape `lib/routines/crypto` produces, so it cannot be mistaken
 * for a working credential by anything that reads it.
 */
export const MISSING_SECRET = "not-exported: re-enter this channel's credential";

/** Why every restored routine arrives switched off. */
export const PAUSED_ON_RESTORE =
  "Restored from an export. The delivery credential could not travel between " +
  "installs — re-enter it on this channel, then resume.";

/**
 * Rows the restore cannot replay as they were read.
 *
 * Three of them, each because the database refuses the honest version:
 *
 * - **Memberships.** Everybody collapses to one account, so replaying five
 *   members would be five inserts of the same primary key — four swallowed by
 *   `on conflict do nothing` and the survivor carrying whichever role sorted
 *   first. That can hand the restorer a `member` row in their own workspace and
 *   lock them out of it. One row, admin, every other column from the earliest.
 * - **Delivery channels.** The secret is `not null` and cannot be exported, so
 *   the column gets a value that is visibly not a credential. Skipping the
 *   table instead was not available: `routines.delivery_channel_id` is `not
 *   null` too, so a workspace with any routine would have had nothing to
 *   restore at all.
 * - **Routines.** Which is what makes the line above tolerable rather than a
 *   trap. A routine whose channel holds no real secret cannot deliver, so it
 *   comes back paused with the reason on its own row — where the person looking
 *   at it will actually read it — instead of running on schedule and failing
 *   somewhere they are not looking.
 */
function rewriteForRestore(table: string, rows: Row[]): Row[] {
  if (rows.length === 0) return rows;
  if (table === "workspace_members") return [{ ...rows[0], role: "admin" }];
  if (table === "delivery_channels") {
    return rows.map((r) => ({ ...r, secret_ciphertext: MISSING_SECRET }));
  }
  if (table === "routines") {
    return rows.map((r) => ({ ...r, status: "paused", paused_reason: PAUSED_ON_RESTORE }));
  }
  return rows;
}
