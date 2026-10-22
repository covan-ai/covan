/**
 * Exports prepared in the background (0132), through the policies.
 *
 * An admin asks in their own name, one at a time per workspace; a member can
 * neither ask nor see. Nobody but the engine moves an export along, and where
 * its file is kept is not a client's to read.
 */

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

beforeAll(async () => {
  ada = await createTestUser("exports-ada");
  bora = await createTestUser("exports-bora");
  const { error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: ada.workspaceId, user_id: bora.id, role: "member" });
  if (error) throw new Error(`could not add bora: ${error.message}`);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("asking for an export", () => {
  it("is an admin's, in their own name, one at a time", async () => {
    const member = await bora.db
      .from("workspace_exports")
      .insert({ workspace_id: ada.workspaceId, requested_by: bora.id });
    expect(member.error).not.toBeNull();

    const forSomebodyElse = await ada.db
      .from("workspace_exports")
      .insert({ workspace_id: ada.workspaceId, requested_by: bora.id });
    expect(forSomebodyElse.error).not.toBeNull();

    const first = await ada.db
      .from("workspace_exports")
      .insert({ workspace_id: ada.workspaceId, requested_by: ada.id })
      .select("id, status")
      .single();
    expect(first.error).toBeNull();
    expect(first.data?.status).toBe("queued");

    const second = await ada.db
      .from("workspace_exports")
      .insert({ workspace_id: ada.workspaceId, requested_by: ada.id });
    expect(second.error?.code).toBe("23505");
  });

  it("is moved along by the engine alone, and its file's place is not a client's to read", async () => {
    const moved = await ada.db
      .from("workspace_exports")
      .update({ status: "ready" })
      .eq("workspace_id", ada.workspaceId);
    expect(moved.error).not.toBeNull();

    const where = await ada.db.from("workspace_exports").select("object_key");
    expect(where.error).not.toBeNull();

    const { data } = await bora.db.from("workspace_exports").select("id");
    expect(data ?? []).toEqual([]);
  });
});
