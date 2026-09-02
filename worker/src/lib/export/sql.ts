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
  // `routines.delivery_channel_id` was here and should never have been: the
  // column is `not null`, so nulling an unreachable reference does not rescue
  // the restore, it fails it in a less obvious place. That case is handled
  // below instead, by giving the routine a channel to point at.
  //
  // `documents.agent_id` was here too and no longer exists — 0004 made
  // `bundle_id` authoritative and a later migration dropped the column, so the
  // entry had been describing nothing for some time.
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

/**
 * The channel a routine points at when its real one could not be exported.
 *
 * A channel belongs to a person (0019), so a workspace where two people each
 * built routines has routines pointing at channels only their own author can
 * read. Exporting as one of them leaves the other's reference unreachable — and
 * `delivery_channel_id` is `not null` with a DEFERRABLE INITIALLY DEFERRED
 * constraint, so the failure is a foreign key violation **at commit**, after
 * every other row has already gone in. The worst place to discover anything.
 *
 * One synthesised row is the answer. It is labelled as what it is, carries the
 * same non-credential as every other restored channel, and the routines that
 * use it come back paused like all the rest — so nothing is silently delivering
 * to a channel somebody did not choose.
 */
export const PLACEHOLDER_CHANNEL_ID = "00000000-0000-4000-8000-000000000001";
export const PLACEHOLDER_CHANNEL_LABEL =
  "unavailable — this routine's channel belonged to someone else";

export type RenderedSql = {
  sql: string;
  /** `table.column` → how many references were dropped as unreachable. */
  droppedReferences: Record<string, number>;
  /** True when a routine had to be pointed at the synthesised channel. */
  usedPlaceholderChannel: boolean;
};

export function renderSql(tables: Collected): RenderedSql {
  const dropped: Record<string, number> = {};
  const known = new Map<string, Set<string>>();
  for (const [table, rows] of Object.entries(tables)) {
    known.set(table, new Set(rows.map((r) => String(r.id ?? "")).filter(Boolean)));
  }

  // Decided before anything is written, because it changes two sections: the
  // routines that point at it, and the channel list that has to contain it.
  const channels = known.get("delivery_channels") ?? new Set<string>();
  const usedPlaceholderChannel = (tables.routines ?? []).some(
    (r) => typeof r.delivery_channel_id === "string" && !channels.has(r.delivery_channel_id),
  );

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
    const needsPlaceholder = spec.table === "delivery_channels" && usedPlaceholderChannel;

    if (rows.length === 0 && !needsPlaceholder) {
      out.push(`-- ${spec.table}: nothing to restore`, "");
      continue;
    }

    // From the rows when there are any, and from the spec when there are not —
    // which is the case that matters here: a member exporting a workspace whose
    // routines all belong to somebody else collects no channels at all, and
    // still needs the synthesised one written or the commit fails.
    const columns = rows.length > 0 ? Object.keys(rows[0]) : declaredColumns(spec.columns);
    out.push(`-- ${spec.table} (${rows.length})`);
    if (needsPlaceholder) {
      out.push(placeholderChannelInsert(columns, tables));
    }
    for (const row of rows) {
      const values = columns.map((column) => {
        if (USER_COLUMNS.has(column)) return ":'owner'";

        const value = row[column];

        // Not nullable, so it is redirected rather than dropped.
        if (spec.table === "routines" && column === "delivery_channel_id") {
          const reachable = typeof value === "string" && channels.has(value);
          if (!reachable) {
            dropped["routines.delivery_channel_id"] =
              (dropped["routines.delivery_channel_id"] ?? 0) + 1;
            return literal(PLACEHOLDER_CHANNEL_ID);
          }
          return literal(value);
        }

        const ref = OPTIONAL_REFS[`${spec.table}.${column}`];
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
  return { sql: out.join("\n"), droppedReferences: dropped, usedPlaceholderChannel };
}

/**
 * The columns a table's rows would have had, when none came back.
 *
 * `delivery_channels` is the only spec that names its columns, and
 * `secret_ciphertext` is deliberately not among them — the export cannot read
 * it. The restore has to write it anyway, so it is added here.
 */
function declaredColumns(columns: string | undefined): string[] {
  const named = (columns ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  return named.includes("secret_ciphertext") ? named : [...named, "secret_ciphertext"];
}

/**
 * The synthesised channel, written with the same columns as the real ones so
 * the section stays one shape.
 *
 * `workspace_id` is provenance and nothing reads it (0019), but pointing it at
 * this workspace is the truthful answer to "where did this come from".
 */
function placeholderChannelInsert(columns: string[], tables: Collected): string {
  const workspaceId = tables.workspaces?.[0]?.id ?? null;
  const values = columns.map((column) => {
    if (USER_COLUMNS.has(column)) return ":'owner'";
    if (column === "id") return literal(PLACEHOLDER_CHANNEL_ID);
    if (column === "workspace_id") return literal(workspaceId);
    if (column === "kind") return literal("email");
    if (column === "label") return literal(PLACEHOLDER_CHANNEL_LABEL);
    if (column === "secret_ciphertext") return literal(MISSING_SECRET);
    // created_at, and anything a later migration adds: let the default decide
    // rather than invent a value for a row that is itself a stand-in.
    return "default";
  });
  return (
    `insert into public.delivery_channels (${columns.join(", ")}) ` +
    `values (${values.join(", ")}) on conflict do nothing;`
  );
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

/**
 * Why every restored connection arrives switched off.
 *
 * Its own sentence rather than a share of the routine one, because the repair
 * is different: a routine needs a credential typed back in, a connection needs
 * the whole OAuth grant made again from the Integrations page — against this
 * install's own Notion or Google client, which is a thing the operator has to
 * have registered before the sentence is even actionable.
 */
export const CONNECTION_PAUSED_ON_RESTORE =
  "Restored from an export. An OAuth grant cannot travel between installs — " +
  "reconnect this source from Integrations, and the documents it already " +
  "imported will be adopted rather than duplicated.";

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
  // Connections are both cases at once: the OAuth token is `not null` and
  // cannot be exported, and a connection that tried to sync without one would
  // fail against the provider every six hours in a workspace nobody has
  // reconnected yet. Same answer as routines, for the same reason — arrive off,
  // with why on the row.
  if (table === "connections") {
    return rows.map((r) => ({
      ...r,
      secret_ciphertext: MISSING_SECRET,
      status: "paused",
      paused_reason: CONNECTION_PAUSED_ON_RESTORE,
    }));
  }
  return rows;
}
