/**
 * What a workspace is made of, and what is deliberately not in the archive.
 *
 * Declared as data rather than written as a sequence of queries, because the
 * list is the interesting part and it has to be reviewable: somebody adding a
 * table to this product should be able to look at one screen and see whether
 * their table belongs in an export. `export.test.ts` fails when a table exists
 * in `supabase/migrations` and appears in neither list here, so the question is
 * asked rather than forgotten.
 *
 * Every read goes through the caller's own client, so row level security
 * decides what comes back. An admin's export and a member's export are
 * different files, and `manifest.json` says which one you are holding rather
 * than implying the archive is the whole workspace.
 */

/** How a table's rows are found. */
export type Scope =
  /** `column = <the workspace id>`. */
  | { kind: "workspace"; column: string }
  /** `column in (<values of `from` collected earlier>)`. */
  | { kind: "in"; column: string; from: { table: string; column: string } };

export type TableSpec = {
  table: string;
  scope: Scope;
  /** Sorted by this, so two exports of unchanged data can be diffed. */
  order: string;
  /**
   * Explicit column list, where `*` would be refused.
   *
   * Only `delivery_channels` needs one. `0023` granted `authenticated` select
   * on six of its seven columns and withheld `secret_ciphertext`, so a `select
   * *` expands to a column the caller may not read and Postgres answers 42501
   * for the whole row. Naming the six is what makes the read succeed — and the
   * seventh being absent is not a gap in the export, it is the point: the
   * ciphertext is bound to this install's `ROUTINE_SECRET_KEY` and would be
   * undecryptable noise anywhere else.
   */
  columns?: string;
};

/**
 * Collection order, which is also insert order.
 *
 * Each table is scoped by ids collected above it, and — with one exception —
 * its foreign keys point only at tables above it too, so `workspace.sql` can be
 * replayed top to bottom. The exception is `routines.delivery_channel_id`,
 * which points *down* at `delivery_channels`: the channels can only be found
 * through the routines that use them, and 0012 made that constraint DEFERRABLE
 * INITIALLY DEFERRED, so it is checked at commit rather than at the insert.
 * That is the whole reason the two orders can stay one list.
 */
export const EXPORTED: TableSpec[] = [
  { table: "workspaces", scope: { kind: "workspace", column: "id" }, order: "created_at" },
  {
    table: "workspace_members",
    scope: { kind: "workspace", column: "workspace_id" },
    order: "created_at",
  },
  // After the memberships it is scoped by, which is the whole reason the order
  // is asserted: put this first and `collectWorkspace` reads an id list that
  // has not been collected yet, exports nobody, and reports success.
  {
    table: "profiles",
    scope: { kind: "in", column: "id", from: { table: "workspace_members", column: "user_id" } },
    order: "id",
  },
  { table: "agents", scope: { kind: "workspace", column: "workspace_id" }, order: "created_at" },
  {
    table: "knowledge_bundles",
    scope: { kind: "workspace", column: "workspace_id" },
    order: "created_at",
  },
  {
    table: "agent_bundles",
    scope: {
      kind: "in",
      column: "bundle_id",
      from: { table: "knowledge_bundles", column: "id" },
    },
    order: "created_at",
  },
  {
    table: "documents",
    scope: { kind: "in", column: "bundle_id", from: { table: "knowledge_bundles", column: "id" } },
    order: "created_at",
  },
  {
    table: "chat_sessions",
    scope: { kind: "workspace", column: "workspace_id" },
    order: "created_at",
  },
  {
    table: "messages",
    scope: { kind: "in", column: "session_id", from: { table: "chat_sessions", column: "id" } },
    order: "created_at",
  },
  { table: "ideas", scope: { kind: "workspace", column: "workspace_id" }, order: "created_at" },
  {
    table: "favorites",
    scope: { kind: "in", column: "agent_id", from: { table: "agents", column: "id" } },
    order: "created_at",
  },
  { table: "routines", scope: { kind: "workspace", column: "workspace_id" }, order: "created_at" },
  {
    // Scoped by the routines that reference it, not by `workspace_id` — and
    // that is a correction rather than a preference. 0019 spells out that a
    // delivery channel belongs to a PERSON: `workspace_id` is written once from
    // whichever workspace was active when it was added and never read again,
    // which is why the column became nullable and stopped cascading.
    //
    // Scoping by it therefore got both directions wrong. It exported channels
    // this workspace does not use, and — the part that broke restores — it
    // missed the channel a routine here actually points at when that channel
    // was added from another workspace. `delivery_channel_id` is `not null`, so
    // a missing one is not a null column, it is a failed transaction.
    //
    // Reading it after `routines` is safe for the restore because
    // `routines_delivery_channel_id_fkey` is DEFERRABLE INITIALLY DEFERRED
    // (0012), so the check happens at commit and the insert order inside the
    // transaction does not matter for this one reference.
    table: "delivery_channels",
    scope: {
      kind: "in",
      column: "id",
      from: { table: "routines", column: "delivery_channel_id" },
    },
    order: "created_at",
    columns: "id,workspace_id,user_id,kind,label,created_at",
  },
  {
    table: "routine_runs",
    scope: { kind: "in", column: "routine_id", from: { table: "routines", column: "id" } },
    order: "started_at",
  },
];

/**
 * Left out, each for a reason that has to survive being read by somebody who
 * wanted the thing that is missing.
 */
export const EXCLUDED: Record<string, string> = {
  document_chunks:
    "derived, and enormous. Every chunk carries a 1536-dimension vector, so a workspace with ten thousand of them is tens of megabytes of numbers that say nothing a human can read. The documents themselves are in this archive; running POST /admin/backfill-embeddings after a restore rebuilds the chunks from them — with whatever embedding model the new install is configured for, which is more useful than replaying the old one's.",
  api_keys:
    "credentials. A key is not a record of what the workspace holds, it is a way to become one of its members, and an archive that carried them would be a key store that people email to each other.",
  routine_deliveries:
    "not readable by a client at all, by design since 0012: it is the engine's own log of what it sent where. Nothing in it is workspace content.",
  invitations:
    "in flight rather than held. An invitation is an offer to somebody who has not accepted, and it is scoped to an install's email and token; replaying one into a new install would either do nothing or invite a stranger.",
  notification_preferences:
    "a person's setting, not a workspace's. It follows the account rather than the room, and the account is not what is being exported.",
  user_onboarding:
    "the same, and about a first run that has already happened. It would mean nothing in a new install.",
  feedback:
    "addressed to the operator, not to the workspace. 0039 keeps it unreadable by anybody but its author for a reason — a note saying what is broken must not be readable by the colleague it is about — and a workspace archive is precisely the thing an admin downloads. Carrying it here would undo the policy through the back door.",
};
