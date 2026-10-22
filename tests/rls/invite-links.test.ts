/**
 * Invite links (0129), read and written through the policies.
 *
 * An admin makes, lists and revokes them; a member can do none of it and sees
 * none of them; no client role reads a token's hash. A link joins as a member
 * or a viewer, never an admin, and stops working when it is revoked.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  type TestUser,
} from "./harness";

let ada: TestUser;
let bora: TestUser;
let cem: TestUser;
const token = `link-${crypto.randomUUID()}`;
const hash = createHash("sha256").update(token).digest("hex");
let linkId: string;

beforeAll(async () => {
  ada = await createTestUser("links-ada");
  bora = await createTestUser("links-bora");
  cem = await createTestUser("links-cem");
  const { error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: ada.workspaceId, user_id: bora.id, role: "member" });
  if (error) throw new Error(`could not add bora: ${error.message}`);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("making a link", () => {
  it("is an admin's, and never for an admin's role", async () => {
    const member = await bora.db.from("invite_links").insert({
      workspace_id: ada.workspaceId,
      role: "member",
      token_hash: hash,
      created_by: bora.id,
    });
    expect(member.error).not.toBeNull();

    const asAdmin = await ada.db.from("invite_links").insert({
      workspace_id: ada.workspaceId,
      role: "admin",
      token_hash: hash,
      created_by: ada.id,
    });
    expect(asAdmin.error?.code).toBe("23514");

    const { data, error } = await ada.db
      .from("invite_links")
      .insert({
        workspace_id: ada.workspaceId,
        role: "member",
        token_hash: hash,
        created_by: ada.id,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    linkId = data!.id as string;
  });

  it("hides the hash from everybody and the links from members", async () => {
    const hashRead = await ada.db.from("invite_links").select("token_hash");
    expect(hashRead.error).not.toBeNull();

    const { data } = await bora.db.from("invite_links").select("id");
    expect(data ?? []).toEqual([]);
  });
});

describe("joining with a link", () => {
  it("makes the holder a member, and counts the use", async () => {
    const { data, error } = await cem.db.rpc("accept_invite_link", { p_token: token });
    expect(error).toBeNull();
    expect(data).toBe(ada.workspaceId);

    const { data: membership } = await serviceClient()
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", ada.workspaceId)
      .eq("user_id", cem.id)
      .single();
    expect(membership?.role).toBe("member");

    const { data: link } = await serviceClient()
      .from("invite_links")
      .select("uses")
      .eq("id", linkId)
      .single();
    expect(link?.uses).toBe(1);
  });

  it("stops working once revoked", async () => {
    const { error } = await ada.db
      .from("invite_links")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", linkId);
    expect(error).toBeNull();

    const late = await createTestUser("links-late");
    const refused = await late.db.rpc("accept_invite_link", { p_token: token });
    expect(refused.error?.code).toBe("P0002");
  });
});
