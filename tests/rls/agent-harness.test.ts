/**
 * What the database says about what an agent DID, and about what it is waiting
 * to be allowed to do.
 *
 * Three tables, two of them new kinds of thing for this schema:
 *
 *  - `message_steps` is a record the SUBJECT must not be able to edit. It says
 *    what the agent ran while writing one reply, and an account the writer can
 *    rewrite is not an account. So no client role holds insert, update or
 *    delete on it, and reading it follows the message it hangs off.
 *  - `paused_turns` holds a whole PROMPT — `messages` is what the model is
 *    about to be shown. A client that could write it could rewrite the input
 *    to a completion somebody else is about to read, which is prompt injection
 *    with a database behind it. So the column is not even selectable.
 *  - `tool_connections` holds a CREDENTIAL, and follows `connections` (0043)
 *    and `delivery_channels` (0012) exactly: no INSERT grant at all, and
 *    `secret_ciphertext` selectable by nobody.
 *
 * The fourth claim is the boring one that is worth proving anyway: none of the
 * three crosses a workspace.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  type TestUser,
} from "./harness";
import { seedWorkspace, type Seeded } from "./fixtures";

const CIPHERTEXT = "v1.harness-test.not-a-real-credential";

let owner: TestUser;
/** In the same workspace, so the session is shared with them. */
let colleague: TestUser;
let outsider: TestUser;
let seeded: Seeded;
let connectionId: string;
let pausedId: string;

beforeAll(async () => {
  owner = await createTestUser("harness-owner");
  colleague = await createTestUser("harness-colleague");
  outsider = await createTestUser("harness-outsider");

  const service = serviceClient();
  const { error: memberError } = await service
    .from("workspace_members")
    .insert({ workspace_id: owner.workspaceId, user_id: colleague.id, role: "member" });
  if (memberError) throw new Error(`seeding member failed: ${memberError.message}`);

  seeded = await seedWorkspace(owner, "shared");

  // An assistant reply to hang steps off. Written with the service role for
  // the reason 0009 gives: a client may not author an assistant message.
  const { data: reply, error: replyError } = await service
    .from("messages")
    .insert({ session_id: seeded.sessionId, role: "assistant", content: "Twenty days." })
    .select("id")
    .single();
  if (replyError) throw new Error(`seeding reply failed: ${replyError.message}`);

  const { error: stepError } = await service.from("message_steps").insert({
    message_id: reply.id,
    step_index: 0,
    tool: "search_documents",
    request: { query: "vacation" },
    result_excerpt: "20 days",
    status: "ok",
    duration_ms: 12,
  });
  if (stepError) throw new Error(`seeding step failed: ${stepError.message}`);

  const { data: connection, error: connectionError } = await service
    .from("tool_connections")
    .insert({
      workspace_id: owner.workspaceId,
      label: "Covan Supabase",
      transport: "sql",
      base_url: "https://proj.supabase.co/rest/v1",
      auth_kind: "static_header",
      config: { rpc: "covan_query" },
      secret_ciphertext: CIPHERTEXT,
      created_by: owner.id,
    })
    .select("id")
    .single();
  if (connectionError) throw new Error(`seeding connection failed: ${connectionError.message}`);
  connectionId = connection.id as string;

  const { data: paused, error: pausedError } = await service
    .from("paused_turns")
    .insert({
      session_id: seeded.sessionId,
      message_id: reply.id,
      workspace_id: owner.workspaceId,
      agent_id: seeded.agentId,
      user_id: owner.id,
      tool: "schedule_job",
      tool_call: { id: "call_1", name: "schedule_job", arguments: "{}" },
      summary: "Create a routine?",
      proposal: { cron: "0 9 * * 1" },
      messages: [{ role: "system", content: "the whole prompt, which is the point" }],
      model: "gpt-4.1",
    })
    .select("id")
    .single();
  if (pausedError) throw new Error(`seeding paused turn failed: ${pausedError.message}`);
  pausedId = paused.id as string;
});

afterAll(async () => {
  await destroyTestUsers([owner, colleague, outsider]);
  await closeSql();
});

describe("message_steps", () => {
  it("is readable by anybody who can read the reply it belongs to", async () => {
    for (const reader of [owner, colleague]) {
      const { data, error } = await reader.db.from("message_steps").select("tool");
      expect(error, `${reader.email}`).toBeNull();
      expect(data, `${reader.email}`).toHaveLength(1);
    }
  });

  it("is invisible to somebody outside the workspace", async () => {
    const { data } = await outsider.db.from("message_steps").select("tool");
    expect(data).toEqual([]);
  });

  /**
   * The claim that matters. The agent's own account of what it did is written
   * by the worker and by nothing else — a caller who could insert a row here
   * could claim the agent checked a source it never opened.
   */
  it("cannot be written by any client, not even the owner of the reply", async () => {
    const { error } = await owner.db.from("message_steps").insert({
      message_id: seeded.messageId,
      step_index: 99,
      tool: "invented",
      status: "ok",
    });
    expect(error).not.toBeNull();
  });

  it("cannot be edited into saying something else", async () => {
    const { data } = await owner.db
      .from("message_steps")
      .update({ tool: "something_else" })
      .eq("tool", "search_documents")
      .select("tool");
    expect(data ?? []).toEqual([]);
    const { data: after } = await owner.db.from("message_steps").select("tool");
    expect(after?.[0]?.tool).toBe("search_documents");
  });

  it("cannot be deleted to hide what the agent tried", async () => {
    await owner.db.from("message_steps").delete().eq("tool", "search_documents");
    const { data } = await owner.db.from("message_steps").select("tool");
    expect(data).toHaveLength(1);
  });
});

describe("paused_turns", () => {
  it("is visible in a shared session to everybody who can see the conversation", async () => {
    for (const reader of [owner, colleague]) {
      const { data, error } = await reader.db.from("paused_turns").select("id, summary");
      expect(error, `${reader.email}`).toBeNull();
      expect(data, `${reader.email}`).toHaveLength(1);
    }
  });

  it("is invisible to somebody outside the workspace", async () => {
    const { data } = await outsider.db.from("paused_turns").select("id");
    expect(data).toEqual([]);
  });

  /**
   * `messages` is the prompt the model is about to be shown. Selecting it is
   * not a leak of anything the reader could not already read — they can see
   * the transcript — but WRITING it would be, and PostgREST will not let a
   * column be updated that it may not select. Withholding the read is what
   * closes the write for good.
   */
  it("does not hand the stored prompt to any client", async () => {
    const { error } = await owner.db.from("paused_turns").select("messages");
    expect(error).not.toBeNull();
  });

  it("does not hand over the tool call either", async () => {
    const { error } = await owner.db.from("paused_turns").select("tool_call");
    expect(error).not.toBeNull();
  });

  it("cannot be approved from the browser, only through the worker", async () => {
    const { data } = await owner.db
      .from("paused_turns")
      .update({ status: "approved" })
      .eq("id", pausedId)
      .select("id");
    expect(data ?? []).toEqual([]);
    const { data: after } = await serviceClient()
      .from("paused_turns")
      .select("status")
      .eq("id", pausedId)
      .single();
    expect(after?.status).toBe("pending");
  });

  it("cannot be invented by a client", async () => {
    const { error } = await owner.db.from("paused_turns").insert({
      session_id: seeded.sessionId,
      workspace_id: owner.workspaceId,
      agent_id: seeded.agentId,
      user_id: owner.id,
      tool: "send_email",
      tool_call: { id: "x", name: "send_email", arguments: "{}" },
      summary: "trust me",
      messages: [],
    });
    expect(error).not.toBeNull();
  });
});

describe("tool_connections", () => {
  it("is readable by every member, so an agent's reach is not a secret from the team", async () => {
    for (const reader of [owner, colleague]) {
      const { data, error } = await reader.db.from("tool_connections").select("label, base_url");
      expect(error, `${reader.email}`).toBeNull();
      expect(data, `${reader.email}`).toHaveLength(1);
    }
  });

  it("is invisible to another workspace", async () => {
    const { data } = await outsider.db.from("tool_connections").select("id");
    expect(data).toEqual([]);
  });

  it("never hands the credential to a client, even the one who created it", async () => {
    const { error } = await owner.db.from("tool_connections").select("secret_ciphertext");
    expect(error).not.toBeNull();
  });

  it("cannot be selected sideways through a wildcard either", async () => {
    // `select *` expands to every column the caller may read, so this must
    // succeed and must not contain the ciphertext — the failure mode worth
    // checking is a grant written to include it by accident.
    const { data, error } = await owner.db.from("tool_connections").select("*").single();
    expect(error).toBeNull();
    expect(data).not.toHaveProperty("secret_ciphertext");
  });

  it("cannot be created by a client, because the worker holds the key", async () => {
    const { error } = await owner.db.from("tool_connections").insert({
      workspace_id: owner.workspaceId,
      label: "Smuggled",
      transport: "http",
      base_url: "https://evil.test",
      auth_kind: "static_header",
      secret_ciphertext: "plaintext-token",
    });
    expect(error).not.toBeNull();
  });

  it("can be renamed and re-scoped by its creator", async () => {
    const { data, error } = await owner.db
      .from("tool_connections")
      .update({ label: "Covan Supabase (prod)", allowed_methods: ["GET", "HEAD"] })
      .eq("id", connectionId)
      .select("label, allowed_methods")
      .single();
    expect(error).toBeNull();
    expect(data?.label).toBe("Covan Supabase (prod)");
  });

  /**
   * An ordinary member may see a connection and may not re-point it. The
   * policy admits the creator or a workspace admin, and this colleague is
   * neither — so the update matches no row rather than being refused, which
   * is what an RLS update looks like from the client.
   */
  it("cannot be re-pointed by a member who did not make it", async () => {
    const { data } = await colleague.db
      .from("tool_connections")
      .update({ label: "Somewhere else" })
      .eq("id", connectionId)
      .select("id");
    expect(data ?? []).toEqual([]);
  });

  it("refuses a second connection with the same name in one workspace", async () => {
    const { error } = await serviceClient().from("tool_connections").insert({
      workspace_id: owner.workspaceId,
      // Case-insensitively the same as the renamed one above.
      label: "  covan supabase (PROD) ",
      transport: "http",
      base_url: "https://api.example.com",
      auth_kind: "static_header",
      secret_ciphertext: CIPHERTEXT,
      created_by: owner.id,
    });
    expect(error?.code).toBe("23505");
  });

  it("refuses a base URL that is not http or https", async () => {
    const { error } = await serviceClient().from("tool_connections").insert({
      workspace_id: owner.workspaceId,
      label: "File scheme",
      transport: "http",
      base_url: "file:///etc/passwd",
      auth_kind: "static_header",
      secret_ciphertext: CIPHERTEXT,
      created_by: owner.id,
    });
    expect(error?.code).toBe("23514");
  });

  it("refuses a transport this build has no code for", async () => {
    const { error } = await serviceClient().from("tool_connections").insert({
      workspace_id: owner.workspaceId,
      label: "MCP, one day",
      transport: "mcp",
      base_url: "https://mcp.example.com",
      auth_kind: "static_header",
      secret_ciphertext: CIPHERTEXT,
      created_by: owner.id,
    });
    expect(error?.code).toBe("23514");
  });
});
