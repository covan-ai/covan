/**
 * The policies on the three tables that hold somebody else's credentials.
 *
 * `connections` and `slack_installations` each carry an encrypted OAuth token,
 * and 0040/0041 protect them the way 0012 protects a delivery channel: row
 * level security decides which rows you see, and a column-level grant decides
 * that `secret_ciphertext` is not one of the columns anybody sees. Neither half
 * is provable from TypeScript — the API could stop selecting the column and the
 * database would still hand it over — so it is proved here, against a real
 * PostgREST with a real JWT.
 *
 * The insert paths are deliberately service-role: creation goes through the
 * worker, which has to encrypt the token before the database sees it. That is
 * exactly what makes "authenticated cannot insert" worth asserting — it is the
 * property the design rests on, and it is one restored grant away from being
 * false.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  type TestUser,
} from "./harness";

let owner: TestUser;
let outsider: TestUser;
let bundleId: string;
let connectionId: string;
let installationId: string;

/** The shape the worker writes. Not a real token — nothing here decrypts it. */
const CIPHERTEXT = "v1.AAAAAAAAAAAAAAAA.ZmFrZS1jaXBoZXJ0ZXh0";

beforeAll(async () => {
  owner = await createTestUser("connections-owner");
  outsider = await createTestUser("connections-outsider");

  const { data: bundle, error: bundleError } = await owner.db
    .from("knowledge_bundles")
    .insert({ workspace_id: owner.workspaceId, name: "Handbook", created_by: owner.id })
    .select("id")
    .single();
  if (bundleError || !bundle) throw new Error(`seeding bundle failed: ${bundleError?.message}`);
  bundleId = bundle.id;

  const service = serviceClient();

  const { data: connection, error: connectionError } = await service
    .from("connections")
    .insert({
      workspace_id: owner.workspaceId,
      bundle_id: bundleId,
      user_id: owner.id,
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

  const { data: installation, error: installError } = await service
    .from("slack_installations")
    .insert({
      workspace_id: owner.workspaceId,
      team_id: `T-${crypto.randomUUID()}`,
      team_name: "Covan",
      bot_user_id: "U-BOT",
      secret_ciphertext: CIPHERTEXT,
      installed_by: owner.id,
    })
    .select("id")
    .single();
  if (installError || !installation) {
    throw new Error(`seeding slack installation failed: ${installError?.message}`);
  }
  installationId = installation.id;
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("a connection's credential", () => {
  it("is not selectable, even by the person who created it", async () => {
    const { error } = await owner.db
      .from("connections")
      .select("id, secret_ciphertext")
      .eq("id", connectionId);

    // 42501: the column grant, not the row policy. The row is visible; this one
    // column is not, which is the whole distinction 0040 relies on.
    expect(error).not.toBeNull();
  });

  it("does not come back with the columns that are selectable", async () => {
    const { data, error } = await owner.db
      .from("connections")
      .select("id, provider, account_label, status")
      .eq("id", connectionId)
      .single();

    expect(error).toBeNull();
    expect(data).toMatchObject({ provider: "notion", account_label: "Covan HQ" });
    expect(data).not.toHaveProperty("secret_ciphertext");
  });

  it("is invisible to somebody in another workspace", async () => {
    const { data, error } = await outsider.db.from("connections").select("id, provider");

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

describe("who may create a connection", () => {
  // Creation goes through the worker, which encrypts the token first. A client
  // that could insert could store a plaintext token — or a row pointing at
  // another workspace's bundle.
  it("nobody, through the Data API", async () => {
    const { error } = await owner.db.from("connections").insert({
      workspace_id: owner.workspaceId,
      bundle_id: bundleId,
      user_id: owner.id,
      provider: "notion",
      account_label: "Hand-written",
      secret_ciphertext: "plaintext",
    });

    expect(error).not.toBeNull();
  });
});

describe("what an owner may change", () => {
  it("can pause it and change how often it syncs", async () => {
    const { error } = await owner.db
      .from("connections")
      .update({ status: "paused", sync_interval_minutes: 1440 })
      .eq("id", connectionId);

    expect(error).toBeNull();
  });

  // The bundle is where the documents land. Moving it through PostgREST would
  // point somebody else's Notion at a bundle of your choosing, which is why the
  // column grant withholds it — the API sets it with the service role.
  it("cannot repoint it at another bundle", async () => {
    const { error } = await owner.db
      .from("connections")
      .update({ bundle_id: bundleId })
      .eq("id", connectionId);

    expect(error).not.toBeNull();
  });

  it("cannot overwrite the stored credential", async () => {
    const { error } = await owner.db
      .from("connections")
      .update({ secret_ciphertext: "mine now" })
      .eq("id", connectionId);

    expect(error).not.toBeNull();
  });

  it("is not deletable by somebody in another workspace", async () => {
    const { data } = await outsider.db.from("connections").delete().eq("id", connectionId).select();
    expect(data ?? []).toEqual([]);

    const { data: still } = await serviceClient()
      .from("connections")
      .select("id")
      .eq("id", connectionId)
      .maybeSingle();
    expect(still).not.toBeNull();
  });
});

describe("a Slack installation", () => {
  it("keeps its bot token out of every client's reach", async () => {
    const { error } = await owner.db
      .from("slack_installations")
      .select("id, secret_ciphertext")
      .eq("id", installationId);

    expect(error).not.toBeNull();
  });

  it("is visible to its own workspace and to nobody else", async () => {
    const { data: mine, error } = await owner.db
      .from("slack_installations")
      .select("id, team_name");
    expect(error).toBeNull();
    expect(mine).toHaveLength(1);

    const { data: theirs } = await outsider.db.from("slack_installations").select("id");
    expect(theirs).toEqual([]);
  });

  // Which agent answers is a workspace decision and the one field a client may
  // set. Everything else — the team, the bot user, the token — is written once,
  // by the install callback.
  it("lets the installer choose the agent and nothing else", async () => {
    const { error: teamError } = await owner.db
      .from("slack_installations")
      .update({ team_id: "T-somebody-elses" })
      .eq("id", installationId);
    expect(teamError).not.toBeNull();

    const { data: agent } = await owner.db
      .from("agents")
      .insert({ workspace_id: owner.workspaceId, name: "Answering agent", created_by: owner.id })
      .select("id")
      .single();

    const { error: agentError } = await owner.db
      .from("slack_installations")
      .update({ agent_id: agent!.id })
      .eq("id", installationId);
    expect(agentError).toBeNull();
  });
});

describe("a Slack identity", () => {
  // The mapping from a Slack user to a Covan account is what makes every reply
  // answer as the person who asked. A client that could write one could answer
  // as somebody else.
  it("cannot be written by a client", async () => {
    const { error } = await owner.db.from("slack_identities").insert({
      installation_id: installationId,
      slack_user_id: "U-SOMEBODY",
      user_id: owner.id,
    });

    expect(error).not.toBeNull();
  });

  it("is readable inside the workspace and unlinkable by the person it names", async () => {
    const { error: seedError } = await serviceClient().from("slack_identities").insert({
      installation_id: installationId,
      slack_user_id: "U-OWNER",
      user_id: owner.id,
    });
    expect(seedError).toBeNull();

    const { data: mine } = await owner.db.from("slack_identities").select("slack_user_id");
    expect(mine).toHaveLength(1);

    const { data: theirs } = await outsider.db.from("slack_identities").select("slack_user_id");
    expect(theirs).toEqual([]);

    const { data: removed } = await owner.db
      .from("slack_identities")
      .delete()
      .eq("slack_user_id", "U-OWNER")
      .select();
    expect(removed).toHaveLength(1);
  });
});
