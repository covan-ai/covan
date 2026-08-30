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
 * In insert order. Each table's foreign keys point only at tables above it, so
 * `workspace.sql` can be replayed top to bottom without deferring anything.
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
  {
    table: "delivery_channels",
    scope: { kind: "workspace", column: "workspace_id" },
    order: "created_at",
    columns: "id,workspace_id,user_id,kind,label,created_at",
  },
  { table: "routines", scope: { kind: "workspace", column: "workspace_id" }, order: "created_at" },
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
};
