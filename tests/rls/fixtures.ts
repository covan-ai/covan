/**
 * Builds one workspace's worth of real content, through the owner's own client.
 *
 * Everything here is inserted the way the app inserts it — as the signed-in
 * user, subject to the same policies — with one exception noted below. If a
 * future migration tightens an insert policy, seeding fails loudly rather than
 * quietly seeding nothing and leaving the isolation tests to pass against an
 * empty workspace.
 */

import { serviceClient, type TestUser } from "./harness";

export type Seeded = {
  agentId: string;
  bundleId: string;
  documentId: string;
  sessionId: string;
  messageId: string;
  routineId: string;
  channelId: string;
  ideaId: string;
};

/** `insert().select().single()` with the error turned into something readable. */
async function insert(
  user: TestUser,
  table: string,
  values: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await user.db.from(table).insert(values).select("id").single();
  if (error) {
    throw new Error(`seeding ${table} as ${user.email} failed: ${error.message}`);
  }
  return data.id as string;
}

/** What `agents.workspace_access` may hold (0104); null is "Only me". */
export type AgentAccess = "use" | "edit" | "manage";

export type SeedOptions = {
  /**
   * `agents.workspace_access` for the seeded agent. Defaults to 'edit', which
   * is NOT the app's default: a new agent starts as Only me (null) since 0104.
   *
   * The default is the world every file here was written in. Before 0104 every
   * member saw every agent and every writer could change it, so the dozens of
   * tests that hand a co-member `seeded.agentId` — to chat with, to attach
   * knowledge to, to grant a capability on — mean "a workspace agent", and
   * 'edit' is exactly what 0104 backfilled existing agents to. What 'edit'
   * does not give a plain member is deleting or restoring an agent somebody
   * else made; viewer.test.ts says so out loud. Pass null to seed an agent
   * the way the app now makes one; agent-sharing.test.ts is where that
   * world is tested.
   */
  workspaceAccess?: AgentAccess | null;
};

/**
 * @param visibility applies to the chat session and the routine. 'private' is
 * the default the app uses; 'shared' opts them into workspace-wide visibility,
 * which is the distinction membership.test.ts turns on.
 */
export async function seedWorkspace(
  user: TestUser,
  visibility: "private" | "shared" = "private",
  options: SeedOptions = {},
): Promise<Seeded> {
  const workspaceAccess = options.workspaceAccess === undefined ? "edit" : options.workspaceAccess;
  const agentId = await insert(user, "agents", {
    workspace_id: user.workspaceId,
    name: "Seeded agent",
    created_by: user.id,
    workspace_access: workspaceAccess,
  });

  // Shared, as every bundle was before 0106: the suites built on this seed are
  // about what a workspace member may do with the workspace's knowledge.
  // `knowledge-scope.test.ts` is about a private one.
  const bundleId = await insert(user, "knowledge_bundles", {
    workspace_id: user.workspaceId,
    name: "Seeded bundle",
    created_by: user.id,
    scope: "workspace",
  });

  const documentId = await insert(user, "documents", {
    bundle_id: bundleId,
    name: "seeded.txt",
    content: "the contents of a document nobody else should read",
  });

  const sessionId = await insert(user, "chat_sessions", {
    agent_id: agentId,
    user_id: user.id,
    workspace_id: user.workspaceId,
    visibility,
    title: "Seeded session",
  });

  const messageId = await insert(user, "messages", {
    session_id: sessionId,
    sender_id: user.id,
    role: "user",
    content: "a message nobody else should read",
  });

  const ideaId = await insert(user, "ideas", {
    session_id: sessionId,
    workspace_id: user.workspaceId,
    title: "Seeded idea",
    created_by: user.id,
  });

  // delivery_channels has no INSERT policy at all — the API creates them with
  // the service-role client (worker/src/routes/routines.ts), because the row
  // holds an encrypted secret and the route, not the database, decides what
  // goes in it. So the fixture has to do the same.
  const service = serviceClient();
  const { data: channel, error: channelError } = await service
    .from("delivery_channels")
    .insert({
      workspace_id: user.workspaceId,
      user_id: user.id,
      kind: "email",
      label: "s••••d@covan.test",
      secret_ciphertext: "not-a-real-ciphertext",
    })
    .select("id")
    .single();
  if (channelError) {
    throw new Error(`seeding delivery_channels failed: ${channelError.message}`);
  }
  const channelId = channel.id as string;

  const routineId = await insert(user, "routines", {
    workspace_id: user.workspaceId,
    agent_id: agentId,
    user_id: user.id,
    name: "Seeded routine",
    visibility,
    source_kind: "web",
    source_config: { url: "https://example.com/feed" },
    instruction: "summarise",
    delivery_channel_id: channelId,
    schedule_cron: "0 9 * * *",
  });

  return { agentId, bundleId, documentId, sessionId, messageId, routineId, channelId, ideaId };
}
