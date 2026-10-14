/**
 * Closing an account counts workspaces' members in the database (0091).
 *
 * `DELETE /account` used to read every member of every workspace the person
 * was in through PostgREST, which stops at a thousand rows without saying so.
 * A person in a large workspace and a small one saw the large one's thousand
 * rows and none of the small one's, judged the small one theirs alone, and
 * the service role deleted it with its other members still inside. A viewer
 * in somebody else's team could delete the team by closing their own account.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  sql,
  type TestUser,
} from "./harness";

let closer: TestUser;
let victim: TestUser;
const FILLERS = 1001;
const fillerTag = `m6-filler-${crypto.randomUUID()}`;

beforeAll(async () => {
  closer = await createTestUser("closure-closer");
  victim = await createTestUser("closure-victim");

  // The closer is a viewer in the victim's team...
  const { error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: victim.workspaceId, user_id: closer.id, role: "viewer" });
  if (error) throw new Error(`could not seat the closer: ${error.message}`);

  // ...and runs a workspace of their own with more members than PostgREST
  // returns in one read.
  await sql()`
    insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
    select gen_random_uuid(), ${fillerTag} || '-' || g || '@covan.test',
           '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '{}'
      from generate_series(1, ${FILLERS}) g`;
  await sql()`
    insert into public.workspace_members (workspace_id, user_id, role)
    select ${closer.workspaceId}::uuid, u.id, 'member'
      from auth.users u where u.email like ${fillerTag + "-%"}`;
}, 120_000);

afterAll(async () => {
  await sql()`delete from public.workspaces where created_by in
              (select id from auth.users where email like ${fillerTag + "-%"})`;
  await sql()`delete from auth.users where email like ${fillerTag + "-%"}`;
  await destroyTestUsers();
  await closeSql();
}, 120_000);

describe("the closure plan", () => {
  it("counts every member, past the thousand a read returns", async () => {
    const { data, error } = await closer.db.rpc("account_closure_plan");
    expect(error).toBeNull();
    const byWorkspace = new Map(
      (data as Array<{ workspace_id: string; other_members: number; other_admins: number }>).map(
        (r) => [r.workspace_id, r],
      ),
    );

    expect(Number(byWorkspace.get(closer.workspaceId)?.other_members)).toBe(FILLERS);
    // The workspace a truncated survey called empty is not empty.
    expect(Number(byWorkspace.get(victim.workspaceId)?.other_members)).toBe(1);
    expect(Number(byWorkspace.get(victim.workspaceId)?.other_admins)).toBe(1);
  });

  it("is the caller's own: the anon key cannot run it", async () => {
    const { anonClient } = await import("./harness");
    const { error } = await anonClient().rpc("account_closure_plan");
    expect(error?.code).toBe("42501");
  });
});

describe("the delete", () => {
  it("does not take a workspace that has somebody else in it", async () => {
    const { data, error } = await serviceClient().rpc("delete_workspace_if_sole_member", {
      p_workspace_id: victim.workspaceId,
      p_user_id: closer.id,
    });
    expect(error).toBeNull();
    expect(data).toBe(false);

    const { data: still } = await serviceClient()
      .from("workspaces")
      .select("id")
      .eq("id", victim.workspaceId);
    expect(still).toHaveLength(1);
  });

  it("takes one that is the person's alone", async () => {
    const loner = await createTestUser("closure-loner");
    const { data } = await serviceClient().rpc("delete_workspace_if_sole_member", {
      p_workspace_id: loner.workspaceId,
      p_user_id: loner.id,
    });
    expect(data).toBe(true);
  });

  it("is the service role's alone", async () => {
    const { error } = await closer.db.rpc("delete_workspace_if_sole_member", {
      p_workspace_id: closer.workspaceId,
      p_user_id: closer.id,
    });
    expect(error?.code).toBe("42501");
  });
});
