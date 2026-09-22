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
    // Above `documents`, and that placement is the whole of its difficulty.
    // `documents.connection_id` is an ordinary foreign key — 0043 had no reason
    // to make it deferrable the way 0012 made `routines.delivery_channel_id` —
    // so a synced document inserted before its connection is a failed
    // transaction rather than a dropped column.
    //
    // Columns are named for the same reason `delivery_channels` names its own:
    // 0043 withholds `secret_ciphertext` from `authenticated`, so `select *`
    // expands to a column the caller may not read and Postgres answers 42501
    // for the whole row. The OAuth token being absent is the point rather than
    // a gap — it is bound to this install's ROUTINE_SECRET_KEY, and to a
    // redirect URI registered against this install's client id.
    table: "connections",
    scope: { kind: "workspace", column: "workspace_id" },
    order: "created_at",
    columns:
      "id,workspace_id,bundle_id,user_id,provider,account_label,config,status," +
      "paused_reason,paused_code,sync_interval_minutes,next_sync_at,last_sync_at," +
      "consecutive_failures,created_at,updated_at",
  },
  {
    table: "connection_runs",
    scope: { kind: "in", column: "connection_id", from: { table: "connections", column: "id" } },
    order: "started_at",
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
    // BELOW `routines`, which is not where it reads most naturally — a document
    // belongs next to its bundle — and is where its foreign keys put it.
    //
    // `documents.routine_id` (0056) points at `routines`, and unlike
    // `routines.delivery_channel_id` it is an ordinary constraint: there was no
    // cycle to break, so there was no reason to make it deferrable. A filed
    // summary inserted before the routine that wrote it is a failed transaction
    // on restore, not a dropped column. `connection_id` puts the same
    // requirement on `connections`, which is above, and `bundle_id` on
    // `knowledge_bundles`, which is further above still — so this is the first
    // position that satisfies all three.
    table: "documents",
    scope: { kind: "in", column: "bundle_id", from: { table: "knowledge_bundles", column: "id" } },
    order: "created_at",
  },
  {
    // Last, and now for two reasons rather than one: `routine_id` points at
    // `routines` and `document_id` (0056) at `documents`, both above.
    table: "routine_runs",
    scope: { kind: "in", column: "routine_id", from: { table: "routines", column: "id" } },
    order: "started_at",
  },
  {
    // Part of the transcript, not an extra. A reply that says "according to
    // the orders database" is only checkable alongside the steps that went
    // and looked — an archive that carried the claim and dropped the evidence
    // would be the export deciding which half of the answer mattered.
    //
    // Scoped through `messages`, which is scoped through `chat_sessions`, so
    // it inherits exactly the visibility the transcript has. Below
    // `documents` because `messages` is far above and nothing here points
    // anywhere else.
    table: "message_steps",
    scope: { kind: "in", column: "message_id", from: { table: "messages", column: "id" } },
    order: "created_at",
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
  routine_triggers:
    "a credential, like api_keys, and the same answer. The row is a SHA-256 of a token somebody pasted into GitHub or a CI job: the export could not read it if it wanted to (0055 grants that column to nobody), and a hash restored into a new install would name a token nobody holds while looking like a working webhook. The routine it belongs to comes back in full, paused like every other, and minting a new token there is one press — which is also the honest state of things, because the sender has to be re-pointed at the new install's URL regardless.",
  invitations:
    "in flight rather than held. An invitation is an offer to somebody who has not accepted, and it is scoped to an install's email and token; replaying one into a new install would either do nothing or invite a stranger.",
  notification_preferences:
    "a person's setting, not a workspace's. It follows the account rather than the room, and the account is not what is being exported.",
  user_onboarding:
    "the same, and about a first run that has already happened. It would mean nothing in a new install.",
  feedback:
    "addressed to the operator, not to the workspace. 0041 keeps it unreadable by anybody but its author for a reason — a note saying what is broken must not be readable by the colleague it is about — and a workspace archive is precisely the thing an admin downloads. Carrying it here would undo the policy through the back door.",
  workspace_events:
    "a record of this install rather than of the work. It says who deleted what and who changed whose role, which is exactly the sort of thing an archive should not carry into somewhere else — and half its rows point at ids the archive deliberately does not contain, because the things they name were deleted. Admins read it in place, on the Team screen, which is where the question it answers gets asked.",
  slack_installations:
    "a relationship between a Slack workspace and one particular Slack app, not workspace content. The bot token cannot be exported (0044 withholds the column) and would be meaningless anyway: a new install has its own Slack app, its own client id, and its own event URL. `team_id` is globally unique too, so restoring one into a database that already has it is a failed transaction rather than a duplicate. Reinstall from Integrations — it takes one click, and the conversations that happened in Slack are in this archive already, as ordinary sessions and messages.",
  slack_threads:
    "the plumbing under those conversations: which Slack thread a session came from. It references an installation that is deliberately not here, and the sessions and messages it points at are exported in full without it. What is lost is the ability to keep replying in the original Slack thread, which a new install could not do regardless.",
  slack_identities:
    "a mapping between two directories, both of which exist outside this archive. It is rebuilt by matching an email the first time somebody asks the agent something, so restoring it would save one lookup and risk carrying a stale one — a person whose Slack account was reassigned would come back attached to the previous holder.",
  connection_capabilities:
    "a catalogue of what this build of Covan can do, not of what this workspace holds. Two installs of the same version have identical rows in it, and an install that does not implement an action has no business being handed a row claiming it does. It is populated by the migration that ships each capability's implementation, which is the only way the table can stay honest.",
  connection_grants:
    "a permission, and permissions do not travel. A grant says an agent may act at a third party through a connection whose OAuth token this archive deliberately does not carry, so a restored one is at best inert and at worst a standing permission arriving in an install where the person who granted it was never asked - possibly attached to somebody else's grant, since the connection comes back unowned and paused. The agents and the connections come back in full; the permissions are granted again by the people who hold them, which is the only way a permission should ever arrive anywhere. Losing them on a restore is the safe direction, because a missing grant means never.",
  capability_calls:
    "the engine's record of what agents attempted at third parties, in the same standing as routine_deliveries: a log of what was sent where rather than workspace content. Its pending rows are worse than useless elsewhere - a pending row is an approval request, and replaying one would ask somebody to approve an action that nothing in the new install can carry out, against a connection restored without a token. The rows are read in place, where the question they answer gets asked.",
  tool_connections:
    "a credential, and the same answer as workspace_provider_keys below. `secret_ciphertext` is granted to no client role (0059), so the export could not read it if it wanted to, and the rest of the row without it is a base URL and a label describing a service the new install cannot reach. Worse than useless, in fact: a restored row would appear in an agent's prompt as a connected service, and every call through it would fail on a credential nobody can supply. Connections are made again, by the person holding the token, in the install that is going to use them.",
  paused_turns:
    "in flight rather than held, in the same standing as invitations. A row here is an agent halfway through a turn, waiting for somebody to approve one action — and the whole of what it is waiting on is a prompt, a tool call and a connection this archive deliberately does not carry. Replaying one would ask somebody in a new install to approve something nothing there can perform. It expires in an hour in the install that made it, which is the honest lifetime of the question.",
  supabase_accounts:
    "a credential, and the most account-wide one in the schema: a Management API token opens every project in somebody's Supabase account, not only the ones connected here. 0061 grants the column to no client role, so the export could not read it if it wanted to, and what is left without it is four characters of a hint. A restored row would be an account that looks connected and can answer nothing, with the projects it opened restored alongside it as services an agent would try and fail to reach. The account is connected again, by the admin holding the token, in the install that is going to use it — which is also the only person who should be deciding that.",
  workspace_provider_keys:
    "credentials, and worse than api_keys above. An API key at least means something on its own; this table's ciphertext opens only under PROVIDER_KEY_SECRET, an operator secret the archive does not and must not contain, so an export of it would be simultaneously useless to whoever downloaded it and a live credential if that secret ever leaked. openai_hint would travel with it — a small disclosure with no compensating use once the ciphertext it identifies cannot be read anyway. 0046 already withholds this table from every client but service_role for the same reason; carrying it into an archive a workspace admin can download would undo that through the back door.",
};
