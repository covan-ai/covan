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

  /**
   * What the turn had spent when it parked (0065). Not on the column whitelist
   * for the same reason as the two above: no client reads it, the worker holds
   * service_role, and a column a client can select is a column PostgREST will
   * let it write into.
   */
  it("does not hand over what the turn spent either", async () => {
    const { error } = await owner.db.from("paused_turns").select("usage");
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

  /**
   * `select *` does not quietly return the columns a caller may read — it
   * expands to every column in the schema cache and is refused whole, with
   * 42501. Worth pinning, because it is the shape of a real mistake: the
   * export spec names `delivery_channels`' six columns by hand for exactly
   * this reason (see `lib/export/tables.ts`), and anything reading this table
   * has to do the same. A change that made the wildcard succeed would mean
   * the credential had become selectable.
   */
  it("refuses a wildcard select rather than quietly dropping the credential", async () => {
    const { error } = await owner.db.from("tool_connections").select("*");
    expect(error?.code).toBe("42501");
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

/**
 * A connected application, which is the second kind of credential this table
 * knows about and the first that is not a credential at all.
 *
 * The token lives at Composio. What the row holds is an address —
 * `connected_account_id` plus `composio_user_id` — and the whole of 0063's
 * argument is that on a deployment where ONE API key opens every workspace's
 * accounts, that address is the boundary. So the two columns are withheld from
 * every client role exactly as `secret_ciphertext` is, and this block is what
 * proves it stayed that way: putting either in `config` instead would have let
 * any member PATCH their own row to another workspace's account and execute
 * against somebody else's mailbox.
 */
describe("a composio connection", () => {
  let appId: string;

  beforeAll(async () => {
    const { data, error } = await serviceClient()
      .from("tool_connections")
      .insert({
        workspace_id: owner.workspaceId,
        label: "Ana's Gmail",
        transport: "composio",
        base_url: "https://backend.composio.dev",
        auth_kind: "composio",
        secret_ciphertext: null,
        toolkit_slug: "gmail",
        connected_account_id: "ca_test_1",
        composio_user_id: "cu_test_1",
        status: "active",
        created_by: owner.id,
      })
      .select("id")
      .single();
    if (error) throw new Error(`seeding composio connection failed: ${error.message}`);
    appId = data.id as string;
  });

  it("shows a member which application it is, and not which account", async () => {
    const { data, error } = await colleague.db
      .from("tool_connections")
      .select("label, toolkit_slug, status")
      .eq("id", appId)
      .single();
    expect(error).toBeNull();
    expect(data).toEqual({ label: "Ana's Gmail", toolkit_slug: "gmail", status: "active" });
  });

  /**
   * The claim this whole design turns on, and the one a reviewer should check
   * first. If it ever passes, a member can read another workspace's account
   * reference — and with one deployment-wide API key behind it, that is enough
   * to act as them.
   */
  it("never hands the account reference to a client, not even its creator", async () => {
    for (const column of ["connected_account_id", "composio_user_id"]) {
      const { error } = await owner.db.from("tool_connections").select(column);
      expect(error, column).not.toBeNull();
    }
  });

  /**
   * The other half of that claim, and the half with no test until now.
   *
   * `config` IS client-writable — 0059 grants `update (label, allowed_methods,
   * config)` to `authenticated`, and the anon key ships in the browser. That is
   * fine and deliberate: what lives in there is a logo. It is also exactly why
   * nothing identifying an account may ever be put there, and the reason to
   * assert the permission rather than only its absence is that the next person
   * to want a field on this row will reach for `config` first. If this test
   * ever has to be changed to make room for an id, the change is wrong.
   */
  it("lets a member edit config, which is why no account reference may live in it", async () => {
    const { error } = await colleague.db
      .from("tool_connections")
      .update({ config: { logo: "https://logos.composio.dev/api/gmail" } })
      .eq("id", appId);
    expect(error).toBeNull();
  });

  it("cannot be re-pointed at another account through an update", async () => {
    // The column is not in the update grant either, so this is refused rather
    // than matching no row — as far as a client is concerned it does not exist.
    const { error } = await owner.db
      .from("tool_connections")
      .update({ connected_account_id: "ca_somebody_else" })
      .eq("id", appId);
    expect(error).not.toBeNull();
  });

  it("refuses a composio row carrying a credential of its own", async () => {
    const { error } = await serviceClient().from("tool_connections").insert({
      workspace_id: owner.workspaceId,
      label: "Smuggled Gmail",
      transport: "composio",
      base_url: "https://backend.composio.dev",
      auth_kind: "composio",
      secret_ciphertext: CIPHERTEXT,
      toolkit_slug: "gmail",
      connected_account_id: "ca_test_2",
      created_by: owner.id,
    });
    expect(error?.code).toBe("23514");
  });

  it("refuses an active composio row that names no account", async () => {
    const { error } = await serviceClient().from("tool_connections").insert({
      workspace_id: owner.workspaceId,
      label: "Orphan Gmail",
      transport: "composio",
      base_url: "https://backend.composio.dev",
      auth_kind: "composio",
      secret_ciphertext: null,
      toolkit_slug: "gmail",
      status: "active",
      created_by: owner.id,
    });
    expect(error?.code).toBe("23514");
  });

  it("allows a pending one, because nobody has finished the consent screen yet", async () => {
    const { error } = await serviceClient().from("tool_connections").insert({
      workspace_id: owner.workspaceId,
      label: "Half-made Linear",
      transport: "composio",
      base_url: "https://backend.composio.dev",
      auth_kind: "composio",
      secret_ciphertext: null,
      toolkit_slug: "linear",
      status: "pending",
      created_by: owner.id,
    });
    expect(error).toBeNull();
  });

  /**
   * The `else` branch of 0063's exhaustive credential check, which exists so a
   * transport added to the CHECK without being added to the shape rule fails
   * closed. An `http` row must not carry Composio's columns.
   */
  it("refuses an ordinary connection carrying a toolkit", async () => {
    const { error } = await serviceClient().from("tool_connections").insert({
      workspace_id: owner.workspaceId,
      label: "Confused API",
      transport: "http",
      base_url: "https://api.example.com",
      auth_kind: "static_header",
      secret_ciphertext: CIPHERTEXT,
      toolkit_slug: "gmail",
      created_by: owner.id,
    });
    expect(error?.code).toBe("23514");
  });

  it("refuses an auth kind this build has no code for", async () => {
    const { error } = await serviceClient().from("tool_connections").insert({
      workspace_id: owner.workspaceId,
      label: "OAuth, one day",
      transport: "http",
      base_url: "https://api.example.com",
      auth_kind: "oauth2",
      secret_ciphertext: CIPHERTEXT,
      created_by: owner.id,
    });
    expect(error?.code).toBe("23514");
  });

  /**
   * 0058's model, on 0063's table. The two departures are the third key column
   * — free text, because a catalogue of fifteen hundred applications cannot be
   * a foreign key — and what an absent row means, which is `ask` here and
   * `never` there. Neither changes who may write what, and that is what these
   * check.
   */
  describe("tool_connection_grants", () => {
    it("lets any writer say an operation should ask", async () => {
      const { error } = await owner.db.from("tool_connection_grants").insert({
        agent_id: seeded.agentId,
        tool_connection_id: appId,
        workspace_id: owner.workspaceId,
        slug: "GMAIL_FETCH_EMAILS",
        mode: "ask",
      });
      expect(error).toBeNull();
    });

    it("refuses a member who is not an admin the standing permission", async () => {
      // Removing the asking forever is a decision about the workspace, not
      // about one piece of work. 0058 exempts a capability its catalogue says
      // is harmless; there is no catalogue here, so every `always` needs an
      // admin — stricter, in the safe direction.
      const { error } = await colleague.db.from("tool_connection_grants").insert({
        agent_id: seeded.agentId,
        tool_connection_id: appId,
        workspace_id: owner.workspaceId,
        slug: "GMAIL_SEND_EMAIL",
        mode: "always",
      });
      expect(error).not.toBeNull();
    });

    it("stamps who granted it rather than believing the client", async () => {
      const { data, error } = await owner.db
        .from("tool_connection_grants")
        .insert({
          agent_id: seeded.agentId,
          tool_connection_id: appId,
          workspace_id: owner.workspaceId,
          slug: "GMAIL_CREATE_DRAFT",
          mode: "ask",
          // A colleague's id, on a row recording who handed an agent a
          // permission. The trigger overwrites it.
          granted_by: colleague.id,
        })
        .select("granted_by")
        .single();
      expect(error).toBeNull();
      expect(data?.granted_by).toBe(owner.id);
    });

    it("cannot join an agent to a connection in another workspace", async () => {
      // Not merely disallowed — impossible, because the process that reads
      // these rows at 3am is the service role, which bypasses RLS entirely. So
      // it has to be a constraint rather than a policy, and this is the service
      // role failing to write it: the agent belongs to the owner's workspace
      // and the row claims the outsider's.
      const { error } = await serviceClient().from("tool_connection_grants").insert({
        agent_id: seeded.agentId,
        tool_connection_id: appId,
        workspace_id: outsider.workspaceId,
        slug: "GMAIL_SEND_EMAIL",
        mode: "always",
      });
      expect(error?.code).toBe("23503");
    });

    it("is invisible across a workspace boundary", async () => {
      const { data } = await outsider.db.from("tool_connection_grants").select("slug");
      expect(data).toEqual([]);
    });

    it("lets an ordinary writer take a permission away", async () => {
      // The asymmetry 0058 argues for: a writer who cannot raise a grant to
      // `always` must still be able to lower one from it, or the only people
      // who could remove a dangerous standing permission would be the people
      // who could give it.
      const { error } = await colleague.db
        .from("tool_connection_grants")
        .delete()
        .eq("tool_connection_id", appId)
        .eq("slug", "GMAIL_FETCH_EMAILS");
      expect(error).toBeNull();
    });

    it("goes when the connection does", async () => {
      const { error } = await serviceClient().from("tool_connections").delete().eq("id", appId);
      expect(error).toBeNull();

      const { data } = await serviceClient()
        .from("tool_connection_grants")
        .select("slug")
        .eq("tool_connection_id", appId);
      expect(data).toEqual([]);
    });
  });
});
