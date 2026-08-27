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

/**
 * @param visibility applies to the chat session and the routine. 'private' is
 * the default the app uses; 'shared' opts them into workspace-wide visibility,
 * which is the distinction membership.test.ts turns on.
 */
export async function seedWorkspace(
  user: TestUser,
  visibility: "private" | "shared" = "private",
): Promise<Seeded> {
  const agentId = await insert(user, "agents", {
    workspace_id: user.workspaceId,
    name: "Seeded agent",
    created_by: user.id,
  });

  const bundleId = await insert(user, "knowledge_bundles", {
    workspace_id: user.workspaceId,
    name: "Seeded bundle",
    created_by: user.id,
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
