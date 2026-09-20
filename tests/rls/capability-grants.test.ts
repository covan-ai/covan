/**
 * What the database says about what an agent may DO.
 *
 * 0058 ships a schema with nothing on top of it: no route, no screen, no tool
 * loop. That is deliberate, and it is exactly why this file has to exist now
 * rather than with the feature. The two decisions in that migration which
 * cannot be walked back later — the key a grant hangs off, and the absence of a
 * row meaning `never` — are only real if the database enforces them, and a
 * policy is only provable against a real Postgres.
 *
 * Four claims, in descending order of how badly it would go if one were false:
 *
 *  1. NO ROW MEANS NO. `record_capability_call` with no grant returns `denied`,
 *     and `denied` is the only status a call with no grant can hold — there is
 *     a check constraint, not a convention.
 *  2. A GRANT CANNOT CROSS A WORKSPACE. The process that reads these rows is
 *     the service role, which bypasses row level security entirely, so this one
 *     is enforced by composite foreign keys rather than by a policy. The test
 *     goes through the service role on purpose: a policy-based guard would pass
 *     the authenticated half of this file and still be wrong where it counts.
 *  3. `authenticated` CANNOT CALL THE EVALUATOR. The grant on the function is
 *     the security boundary — a client that could call it could write itself an
 *     `approved` row without ever touching the update policy.
 *  4. THE STANDING PERMISSION NEEDS AN ADMIN, and taking it away does not.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  type TestUser,
} from "./harness";

const CIPHERTEXT = "v1.capability-test.not-a-real-token";

/** Dangerous: sends something that cannot be unsent. */
const DESTRUCTIVE = "notion.delete_page";
/** Harmless: writes a comment nobody is notified about. */
const HARMLESS = "notion.read_comment";

let admin: TestUser;
let writer: TestUser;
let viewer: TestUser;
let outsider: TestUser;

let agentId: string;
let connectionId: string;
/** An agent in a workspace the connection has nothing to do with. */
let foreignAgentId: string;

beforeAll(async () => {
  admin = await createTestUser("capability-admin");
  writer = await createTestUser("capability-writer");
  viewer = await createTestUser("capability-viewer");
  outsider = await createTestUser("capability-outsider");

  const service = serviceClient();

  const { error: membersError } = await service.from("workspace_members").insert([
    { workspace_id: admin.workspaceId, user_id: writer.id, role: "member" },
    { workspace_id: admin.workspaceId, user_id: viewer.id, role: "viewer" },
  ]);
  if (membersError) throw new Error(`seeding members failed: ${membersError.message}`);

  const { data: agent, error: agentError } = await admin.db
    .from("agents")
    .insert({ workspace_id: admin.workspaceId, name: "Filer", created_by: admin.id })
    .select("id")
    .single();
  if (agentError || !agent) throw new Error(`seeding agent failed: ${agentError?.message}`);
  agentId = agent.id;

  const { data: foreignAgent, error: foreignError } = await outsider.db
    .from("agents")
    .insert({ workspace_id: outsider.workspaceId, name: "Theirs", created_by: outsider.id })
    .select("id")
    .single();
  if (foreignError || !foreignAgent) {
    throw new Error(`seeding the outsider's agent failed: ${foreignError?.message}`);
  }
  foreignAgentId = foreignAgent.id;

  const { data: bundle, error: bundleError } = await admin.db
    .from("knowledge_bundles")
    .insert({ workspace_id: admin.workspaceId, name: "Handbook", created_by: admin.id })
    .select("id")
    .single();
  if (bundleError || !bundle) throw new Error(`seeding bundle failed: ${bundleError?.message}`);

  // Service role, because `secret_ciphertext` is not writable by a client —
  // the worker encrypts before the database ever sees a token.
  const { data: connection, error: connectionError } = await service
    .from("connections")
    .insert({
      workspace_id: admin.workspaceId,
      bundle_id: bundle.id,
      user_id: admin.id,
      provider: "notion",
      account_label: "Covan HQ",
      secret_ciphertext: CIPHERTEXT,
    })
    .select("id")
    .single();
  if (connectionError || !connection) {
    throw new Error(`seeding connection failed: ${connectionError?.message}`);
  }
  connectionId = connection.id;

  // The catalogue ships empty, so the test seeds the two rows it needs. Doing
  // it through the service role is also the only way: there is no insert policy
  // on that table for anybody.
  const { error: catalogueError } = await service.from("connection_capabilities").insert([
    {
      provider: "notion",
      capability: DESTRUCTIVE,
      label: "Delete a page",
      description: "Move a Notion page to the trash.",
      is_destructive: true,
    },
    {
      provider: "notion",
      capability: HARMLESS,
      label: "Read comments",
      description: "Read the comments on a page.",
      is_destructive: false,
    },
  ]);
  if (catalogueError) throw new Error(`seeding catalogue failed: ${catalogueError.message}`);
});

afterAll(async () => {
  const service = serviceClient();
  await service.from("connection_grants").delete().eq("connection_id", connectionId);
  await service.from("connection_capabilities").delete().in("capability", [DESTRUCTIVE, HARMLESS]);
  await destroyTestUsers();
  await closeSql();
});

/** Remove every grant, so each test starts from the default: no row. */
async function clearGrants() {
  await serviceClient().from("connection_grants").delete().eq("connection_id", connectionId);
}

describe("the catalogue", () => {
  it("is readable by anyone signed in", async () => {
    const { data, error } = await writer.db
      .from("connection_capabilities")
      .select("capability, is_destructive")
      .eq("capability", DESTRUCTIVE)
      .single();

    expect(error).toBeNull();
    expect(data?.is_destructive).toBe(true);
  });

  // It describes what this build can do. A client that could add to it could
  // offer a permission for an action no code performs.
  it("is writable by nobody", async () => {
    const { error } = await admin.db.from("connection_capabilities").insert({
      provider: "notion",
      capability: "notion.invented",
      label: "Invented",
      description: "Nothing implements this.",
    });

    expect(error).not.toBeNull();
  });
});

describe("no row means no", () => {
  it("denies a call when there is no grant", async () => {
    await clearGrants();

    const { data, error } = await serviceClient().rpc("record_capability_call", {
      p_agent_id: agentId,
      p_connection_id: connectionId,
      p_capability: DESTRUCTIVE,
      p_request: { page: "abc" },
    });

    expect(error).toBeNull();
    expect(data?.status).toBe("denied");
    expect(data?.mode).toBeNull();
  });

  // The refusal is recorded rather than swallowed. A default of deny is only
  // humane if somebody can find out that it said no.
  it("leaves the refusal where a member can read it", async () => {
    const { data, error } = await admin.db
      .from("capability_calls")
      .select("status, capability")
      .eq("connection_id", connectionId)
      .eq("status", "denied");

    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
  });

  // Not a convention: a constraint. Without it, `denied` is one branch in
  // TypeScript away from becoming `approved`.
  it("refuses to store a call with no grant and any other status", async () => {
    const { error } = await serviceClient().from("capability_calls").insert({
      workspace_id: admin.workspaceId,
      agent_id: agentId,
      connection_id: connectionId,
      provider: "notion",
      capability: DESTRUCTIVE,
      mode: null,
      status: "approved",
    });

    // 23514: check_violation, from capability_calls_no_row_means_no.
    expect(error?.code).toBe("23514");
  });
});

describe("the evaluator", () => {
  // The grant on the function IS the boundary. Revoking from named roles is not
  // enough — Postgres grants EXECUTE to PUBLIC by default.
  it("cannot be called by a signed-in client", async () => {
    const { error } = await admin.db.rpc("record_capability_call", {
      p_agent_id: agentId,
      p_connection_id: connectionId,
      p_capability: DESTRUCTIVE,
    });

    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("turns `ask` into a pending approval", async () => {
    await clearGrants();
    const { error: grantError } = await admin.db.from("connection_grants").insert({
      agent_id: agentId,
      connection_id: connectionId,
      workspace_id: admin.workspaceId,
      provider: "notion",
      capability: DESTRUCTIVE,
      mode: "ask",
    });
    expect(grantError).toBeNull();

    const { data, error } = await serviceClient().rpc("record_capability_call", {
      p_agent_id: agentId,
      p_connection_id: connectionId,
      p_capability: DESTRUCTIVE,
    });

    expect(error).toBeNull();
    expect(data?.status).toBe("pending");
    expect(data?.mode).toBe("ask");
  });

  // `always` means the approval was given in advance, which is why it lands on
  // the same status a person's yes produces. One branch for the caller.
  it("turns `always` into an approval nobody had to give", async () => {
    await clearGrants();
    const { error: grantError } = await admin.db.from("connection_grants").insert({
      agent_id: agentId,
      connection_id: connectionId,
      workspace_id: admin.workspaceId,
      provider: "notion",
      capability: DESTRUCTIVE,
      mode: "always",
    });
    expect(grantError).toBeNull();

    const { data, error } = await serviceClient().rpc("record_capability_call", {
      p_agent_id: agentId,
      p_connection_id: connectionId,
      p_capability: DESTRUCTIVE,
    });

    expect(error).toBeNull();
    expect(data?.status).toBe("approved");
    expect(data?.decided_by).toBeNull();
  });

  it("refuses an agent from another workspace", async () => {
    const { error } = await serviceClient().rpc("record_capability_call", {
      p_agent_id: foreignAgentId,
      p_connection_id: connectionId,
      p_capability: DESTRUCTIVE,
    });

    expect(error).not.toBeNull();
  });
});

describe("who may grant what", () => {
  it("lets any writer grant `ask`", async () => {
    await clearGrants();

    const { error } = await writer.db.from("connection_grants").insert({
      agent_id: agentId,
      connection_id: connectionId,
      workspace_id: admin.workspaceId,
      provider: "notion",
      capability: DESTRUCTIVE,
      mode: "ask",
    });

    expect(error).toBeNull();
  });

  it("refuses a viewer entirely", async () => {
    await clearGrants();

    const { error } = await viewer.db.from("connection_grants").insert({
      agent_id: agentId,
      connection_id: connectionId,
      workspace_id: admin.workspaceId,
      provider: "notion",
      capability: HARMLESS,
      mode: "ask",
    });

    expect(error?.code).toBe("42501");
  });

  // The one rule that needs a role above writer, and only for the combination:
  // a standing permission to do something that cannot be taken back.
  it("refuses a non-admin `always` on a destructive capability", async () => {
    await clearGrants();

    const { error } = await writer.db.from("connection_grants").insert({
      agent_id: agentId,
      connection_id: connectionId,
      workspace_id: admin.workspaceId,
      provider: "notion",
      capability: DESTRUCTIVE,
      mode: "always",
    });

    expect(error?.code).toBe("42501");
  });

  it("allows a non-admin `always` on one that is not destructive", async () => {
    await clearGrants();

    const { error } = await writer.db.from("connection_grants").insert({
      agent_id: agentId,
      connection_id: connectionId,
      workspace_id: admin.workspaceId,
      provider: "notion",
      capability: HARMLESS,
      mode: "always",
    });

    expect(error).toBeNull();
  });

  it("allows an admin the same grant it refuses a writer", async () => {
    await clearGrants();

    const { error } = await admin.db.from("connection_grants").insert({
      agent_id: agentId,
      connection_id: connectionId,
      workspace_id: admin.workspaceId,
      provider: "notion",
      capability: DESTRUCTIVE,
      mode: "always",
    });

    expect(error).toBeNull();
  });

  // THE ASYMMETRY. A writer who cannot raise a grant must still be able to
  // lower one, or the only people who can take a dangerous standing permission
  // away are the people who can give it.
  it("lets a writer lower an admin's `always` back to `ask`", async () => {
    const { error } = await writer.db
      .from("connection_grants")
      .update({ mode: "ask" })
      .eq("agent_id", agentId)
      .eq("connection_id", connectionId)
      .eq("capability", DESTRUCTIVE);

    expect(error).toBeNull();
  });

  it("lets a writer revoke it altogether", async () => {
    const { error } = await writer.db
      .from("connection_grants")
      .delete()
      .eq("agent_id", agentId)
      .eq("connection_id", connectionId)
      .eq("capability", DESTRUCTIVE);

    expect(error).toBeNull();
  });

  it("refuses a writer who is raising it back", async () => {
    await clearGrants();
    await admin.db.from("connection_grants").insert({
      agent_id: agentId,
      connection_id: connectionId,
      workspace_id: admin.workspaceId,
      provider: "notion",
      capability: DESTRUCTIVE,
      mode: "ask",
    });

    const { error } = await writer.db
      .from("connection_grants")
      .update({ mode: "always" })
      .eq("agent_id", agentId)
      .eq("connection_id", connectionId)
      .eq("capability", DESTRUCTIVE);

    expect(error?.code).toBe("42501");
  });

  it("records who granted it, whatever the client claimed", async () => {
    await clearGrants();

    await writer.db.from("connection_grants").insert({
      agent_id: agentId,
      connection_id: connectionId,
      workspace_id: admin.workspaceId,
      provider: "notion",
      capability: DESTRUCTIVE,
      mode: "ask",
      // The colleague who is about to be blamed for this.
      granted_by: admin.id,
    });

    const { data } = await admin.db
      .from("connection_grants")
      .select("granted_by")
      .eq("capability", DESTRUCTIVE)
      .single();

    expect(data?.granted_by).toBe(writer.id);
  });

  it("is invisible to somebody outside the workspace", async () => {
    const { data, error } = await outsider.db
      .from("connection_grants")
      .select("capability")
      .eq("connection_id", connectionId);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

// The composite foreign keys, tested through the service role because that is
// the caller they exist for: a policy would not be consulted here at all.
describe("a grant cannot cross a workspace", () => {
  // From the default, so a duplicate primary key cannot stand in for the
  // foreign key violation each of these is about.
  beforeAll(clearGrants);

  it("refuses an agent that belongs somewhere else", async () => {
    const { error } = await serviceClient().from("connection_grants").insert({
      agent_id: foreignAgentId,
      connection_id: connectionId,
      workspace_id: admin.workspaceId,
      provider: "notion",
      capability: DESTRUCTIVE,
      mode: "ask",
    });

    // 23503: foreign key violation, from connection_grants_agent_fkey.
    expect(error?.code).toBe("23503");
  });

  it("refuses a workspace that owns neither end", async () => {
    const { error } = await serviceClient().from("connection_grants").insert({
      agent_id: agentId,
      connection_id: connectionId,
      workspace_id: outsider.workspaceId,
      provider: "notion",
      capability: DESTRUCTIVE,
      mode: "ask",
    });

    expect(error?.code).toBe("23503");
  });

  it("refuses a capability belonging to another provider", async () => {
    const { error } = await serviceClient().from("connection_grants").insert({
      agent_id: agentId,
      connection_id: connectionId,
      workspace_id: admin.workspaceId,
      provider: "google_drive",
      capability: DESTRUCTIVE,
      mode: "ask",
    });

    expect(error?.code).toBe("23503");
  });

  it("refuses a capability that is not in the catalogue at all", async () => {
    const { error } = await serviceClient().from("connection_grants").insert({
      agent_id: agentId,
      connection_id: connectionId,
      workspace_id: admin.workspaceId,
      provider: "notion",
      capability: "notion.never_shipped",
      mode: "ask",
    });

    expect(error?.code).toBe("23503");
  });
});

describe("answering a pending call", () => {
  let callId: string;

  beforeAll(async () => {
    await clearGrants();
    await admin.db.from("connection_grants").insert({
      agent_id: agentId,
      connection_id: connectionId,
      workspace_id: admin.workspaceId,
      provider: "notion",
      capability: DESTRUCTIVE,
      mode: "ask",
    });

    const { data } = await serviceClient().rpc("record_capability_call", {
      p_agent_id: agentId,
      p_connection_id: connectionId,
      p_capability: DESTRUCTIVE,
      p_request: { page: "handbook" },
    });
    callId = data.id;
  });

  it("refuses a status only the engine may write", async () => {
    const { error } = await admin.db
      .from("capability_calls")
      .update({ status: "performed" })
      .eq("id", callId);

    expect(error?.code).toBe("42501");
  });

  // No error, and that is not a gap in the test. A row the `using` clause
  // hides is not a row the update refuses, it is a row the update does not
  // find — so the proof is that nothing moved.
  it("refuses a viewer", async () => {
    const { error } = await viewer.db
      .from("capability_calls")
      .update({ status: "approved" })
      .eq("id", callId);

    expect(error).toBeNull();

    const { data } = await admin.db
      .from("capability_calls")
      .select("status")
      .eq("id", callId)
      .single();
    expect(data?.status).toBe("pending");
  });

  it("lets a writer say yes, and stamps who said it", async () => {
    const { error } = await writer.db
      .from("capability_calls")
      .update({ status: "approved" })
      .eq("id", callId);

    expect(error).toBeNull();

    const { data } = await admin.db
      .from("capability_calls")
      .select("status, decided_by, decided_at")
      .eq("id", callId)
      .single();

    expect(data?.status).toBe("approved");
    expect(data?.decided_by).toBe(writer.id);
    expect(data?.decided_at).not.toBeNull();
  });

  // Once answered it is answered. Otherwise an approval could be withdrawn
  // after the action, or a refusal quietly turned into a yes an hour later.
  it("refuses a second answer", async () => {
    const { error } = await admin.db
      .from("capability_calls")
      .update({ status: "refused" })
      .eq("id", callId);

    expect(error).toBeNull();

    const { data } = await admin.db
      .from("capability_calls")
      .select("status, decided_by")
      .eq("id", callId)
      .single();
    expect(data?.status).toBe("approved");
    expect(data?.decided_by).toBe(writer.id);
  });

  it("refuses a client that wants to write its own call", async () => {
    const { error } = await admin.db.from("capability_calls").insert({
      workspace_id: admin.workspaceId,
      agent_id: agentId,
      connection_id: connectionId,
      provider: "notion",
      capability: DESTRUCTIVE,
      mode: "always",
      status: "approved",
    });

    expect(error?.code).toBe("42501");
  });

  it("refuses a client that wants to delete the evidence", async () => {
    const { error } = await admin.db.from("capability_calls").delete().eq("id", callId);

    expect(error?.code).toBe("42501");

    const { data } = await admin.db.from("capability_calls").select("id").eq("id", callId);
    expect(data?.length).toBe(1);
  });
});
