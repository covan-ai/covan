/**
 * Accepting an invitation takes the token from its email (0090).
 *
 * Before 0090 a confirmed account at the invited address was the whole
 * credential. A confirmed address proves a mailbox only where the install
 * sends a confirmation, and the compose stack auto-confirms by default, so
 * anybody could sign up as an invitee's address first and accept the
 * invitation in their place -- an admin invitation included. These tests are
 * that account, holding the address and not the email, being refused.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  anonClient,
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  type TestUser,
} from "./harness";

let admin: TestUser;
let invitee: TestUser;
let stranger: TestUser;

function mintToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: createHash("sha256").update(token, "utf8").digest("hex") };
}

/** An invitation the way `POST /invitations` makes one: the admin's own client. */
async function invite(email: string, role = "member"): Promise<{ id: string; token: string }> {
  const { token, hash } = mintToken();
  const { data, error } = await admin.db
    .from("invitations")
    .insert({
      workspace_id: admin.workspaceId,
      email,
      role,
      invited_by: admin.id,
      token_hash: hash,
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not invite: ${error.message}`);
  return { id: data.id as string, token };
}

async function accept(user: TestUser, id: string, token: string | null) {
  return user.db.rpc("accept_invitation", { p_invite_id: id, p_token: token });
}

async function isMember(user: TestUser): Promise<boolean> {
  const { data } = await serviceClient()
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", admin.workspaceId)
    .eq("user_id", user.id);
  return (data ?? []).length > 0;
}

beforeAll(async () => {
  admin = await createTestUser("invite-admin");
  invitee = await createTestUser("invite-invitee");
  stranger = await createTestUser("invite-stranger");
});

// One pending invitation per address per workspace: each test starts clean.
afterEach(async () => {
  await serviceClient()
    .from("invitations")
    .delete()
    .eq("workspace_id", admin.workspaceId)
    .eq("status", "pending");
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("an invitation", () => {
  it("keeps its token hash from every client, the admin who made it included", async () => {
    const { id } = await invite(`hash-${crypto.randomUUID()}@covan.test`);
    const { error } = await admin.db.from("invitations").select("token_hash").eq("id", id);
    expect(error?.code).toBe("42501");

    // And records when the token was minted, without being told.
    const { data } = await admin.db
      .from("invitations")
      .select("token_issued_at")
      .eq("id", id)
      .single();
    expect(data?.token_issued_at).not.toBeNull();
  });

  it("cannot be inserted already accepted, or with a far expiry", async () => {
    for (const extra of [{ status: "accepted" }, { expires_at: "2100-01-01T00:00:00Z" }]) {
      const { error } = await admin.db.from("invitations").insert({
        workspace_id: admin.workspaceId,
        email: `forged-${crypto.randomUUID()}@covan.test`,
        role: "member",
        invited_by: admin.id,
        ...extra,
      });
      expect(error?.code, JSON.stringify(extra)).toBe("42501");
    }
  });
});

describe("accepting", () => {
  it("is refused to the invited address without the token from the email", async () => {
    // The account at the right address is exactly what an auto-confirming
    // install hands to whoever signs up first. Without the email, it is
    // nobody's way in.
    const { id } = await invite(invitee.email, "admin");

    for (const token of [null, "", mintToken().token]) {
      const { error } = await accept(invitee, id, token);
      expect(error?.code, String(token)).toBe("P0002");
    }
    expect(await isMember(invitee)).toBe(false);
  });

  it("is refused to somebody else holding the token", async () => {
    // A forwarded email is not a transferable seat: the address still has to
    // match, and the refusal says nothing about which half was wrong.
    const { id, token } = await invite(invitee.email);
    const { error } = await accept(stranger, id, token);
    expect(error?.code).toBe("P0002");
    expect(await isMember(stranger)).toBe(false);
  });

  it("works with the token at the invited address, once", async () => {
    const { id, token } = await invite(invitee.email);

    const { data, error } = await accept(invitee, id, token);
    expect(error).toBeNull();
    expect(data).toBe(admin.workspaceId);
    expect(await isMember(invitee)).toBe(true);

    // Spent: the hash is gone, and the same link answers like any dead one.
    const { data: row } = await serviceClient()
      .from("invitations")
      .select("status, token_hash")
      .eq("id", id)
      .single();
    expect(row).toEqual({ status: "accepted", token_hash: null });
    expect((await accept(invitee, id, token)).error?.code).toBe("P0002");

    await serviceClient()
      .from("workspace_members")
      .delete()
      .eq("workspace_id", admin.workspaceId)
      .eq("user_id", invitee.id);
  });

  it("is refused once the seven days are up", async () => {
    const { id, token } = await invite(invitee.email);
    await serviceClient()
      .from("invitations")
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq("id", id);
    expect((await accept(invitee, id, token)).error?.code).toBe("P0002");
  });

  it("is not possible through the old one-argument function", async () => {
    const { id } = await invite(`old-${crypto.randomUUID()}@covan.test`);
    const { error } = await invitee.db.rpc("accept_invitation", { p_invite_id: id });
    expect(error?.message ?? "").toMatch(/link in your invitation email/);
  });
});

describe("an invitation made before links existed", () => {
  it("cannot be accepted until an admin sends a new link", async () => {
    // What 0090 finds already pending: no token. The invitee can see it and
    // cannot take it; the admin's Resend is the way forward.
    const { data: legacy, error } = await serviceClient()
      .from("invitations")
      .insert({
        workspace_id: admin.workspaceId,
        email: invitee.email.toUpperCase(),
        role: "viewer",
        invited_by: admin.id,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    expect((await accept(invitee, legacy!.id, "")).error?.code).toBe("P0002");

    // Somebody who is not the workspace's admin gets the same answer as for a
    // row that does not exist.
    const fresh = mintToken();
    const refused = await stranger.db.rpc("reissue_invitation", {
      p_invite_id: legacy!.id,
      p_token_hash: fresh.hash,
    });
    expect(refused.error?.code).toBe("P0002");

    const { error: reissueError } = await admin.db.rpc("reissue_invitation", {
      p_invite_id: legacy!.id,
      p_token_hash: fresh.hash,
    });
    expect(reissueError).toBeNull();

    const { error: acceptError } = await accept(invitee, legacy!.id, fresh.token);
    expect(acceptError).toBeNull();

    const { data: events } = await serviceClient()
      .from("workspace_events")
      .select("action")
      .eq("workspace_id", admin.workspaceId)
      .eq("subject_id", legacy!.id);
    expect((events ?? []).map((e) => e.action)).toContain("invitation.resent");
  });
});

describe("the anon key", () => {
  it("can call neither function", async () => {
    const anon = anonClient();
    const id = crypto.randomUUID();
    const a = await anon.rpc("accept_invitation", { p_invite_id: id, p_token: "x" });
    const b = await anon.rpc("reissue_invitation", {
      p_invite_id: id,
      p_token_hash: "0".repeat(64),
    });
    expect(a.error?.code).toBe("42501");
    expect(b.error?.code).toBe("42501");
  });
});
