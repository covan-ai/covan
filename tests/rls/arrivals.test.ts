/**
 * What arrived, readable by one person (0139).
 *
 * A scan counts what came into somebody's own mailbox and calendar, so it is
 * theirs the way a personal connection is (0098): a teammate does not see it,
 * and neither does an admin of the workspace. The person may queue a scan and
 * may record which routine they made from a bucket; everything else is the
 * engine's, through the service role. A key's token reads none of it, in any
 * workspace — a scan is something a person looks at, not something a script
 * collects.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anonClient,
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  sql,
  type TestUser,
} from "./harness";
import { seedWorkspace, type Seeded } from "./fixtures";

let ada: TestUser;
let grace: TestUser;
let linus: TestUser;
let seeded: Seeded;
/** A scan of Ada's, written by the engine, with one bucket. */
let scanId: string;

const ROLLBACK = Symbol("rollback");

beforeAll(async () => {
  ada = await createTestUser("arrivals-ada");
  grace = await createTestUser("arrivals-grace");
  linus = await createTestUser("arrivals-linus");
  const service = serviceClient();
  for (const [user, role] of [
    [grace, "admin"],
    [linus, "member"],
  ] as const) {
    const { error } = await service
      .from("workspace_members")
      .insert({ workspace_id: ada.workspaceId, user_id: user.id, role });
    if (error) throw new Error(`could not add ${user.email}: ${error.message}`);
  }
  seeded = await seedWorkspace(ada);

  const { data: scan, error: scanError } = await service
    .from("arrival_scans")
    .insert({
      workspace_id: ada.workspaceId,
      user_id: ada.id,
      status: "done",
      taxonomy: 1,
      sources: [{ connection_id: "00000000-0000-0000-0000-000000000001", toolkit: "gmail" }],
      total: 12,
      unanswered: 2,
    })
    .select("id")
    .single();
  if (scanError) throw new Error(`could not seed a scan: ${scanError.message}`);
  scanId = scan.id as string;

  const { error: bucketError } = await service.from("arrival_buckets").insert({
    scan_id: scanId,
    kind: "question",
    label: "Questions about the spring order",
    count: 7,
    unanswered: 2,
    examples: ["Is the spring order still on?"],
    template_id: "arrivals-questions",
  });
  if (bucketError) throw new Error(`could not seed a bucket: ${bucketError.message}`);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

function queue(user: TestUser, values: Record<string, unknown> = {}) {
  return user.db
    .from("arrival_scans")
    .insert({
      workspace_id: ada.workspaceId,
      user_id: user.id,
      sources: [],
      taxonomy: 1,
      ...values,
    })
    .select("id, status")
    .maybeSingle();
}

describe("arrival scans", () => {
  it("a person can queue a scan in their own workspace", async () => {
    const { data, error } = await queue(linus);
    expect(error).toBeNull();
    expect(data?.status).toBe("queued");

    const { data: seen } = await linus.db.from("arrival_scans").select("id").eq("id", data!.id);
    expect(seen).toHaveLength(1);
  });

  it("cannot queue one as somebody else", async () => {
    const { data, error } = await queue(linus, { user_id: ada.id });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("cannot queue one that says it is already running", async () => {
    const { data, error } = await queue(linus, { status: "running" });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("cannot queue one in a workspace they are not in", async () => {
    const { data, error } = await linus.db
      .from("arrival_scans")
      .insert({ workspace_id: grace.workspaceId, user_id: linus.id, sources: [], taxonomy: 1 })
      .select("id")
      .maybeSingle();
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("the owner reads their scan and its buckets", async () => {
    const { data: scans } = await ada.db.from("arrival_scans").select("id").eq("id", scanId);
    expect(scans).toHaveLength(1);
    const { data: buckets } = await ada.db
      .from("arrival_buckets")
      .select("kind, label")
      .eq("scan_id", scanId);
    expect(buckets).toEqual([{ kind: "question", label: "Questions about the spring order" }]);
  });

  it("a teammate reads neither", async () => {
    const { data: scans } = await linus.db.from("arrival_scans").select("id").eq("id", scanId);
    expect(scans).toEqual([]);
    const { data: buckets } = await linus.db.from("arrival_buckets").select("kind").eq("scan_id", scanId);
    expect(buckets).toEqual([]);
  });

  it("an admin of the workspace reads neither", async () => {
    const { data: scans } = await grace.db.from("arrival_scans").select("id").eq("id", scanId);
    expect(scans).toEqual([]);
    const { data: buckets } = await grace.db.from("arrival_buckets").select("kind").eq("scan_id", scanId);
    expect(buckets).toEqual([]);
  });

  it("the owner cannot change the scan itself", async () => {
    const { error } = await ada.db.from("arrival_scans").update({ status: "done" }).eq("id", scanId);
    expect(error).not.toBeNull();
  });
});

describe("the routine a bucket became", () => {
  it("the owner may record it", async () => {
    const { data, error } = await ada.db
      .from("arrival_buckets")
      .update({ routine_id: seeded.routineId })
      .eq("scan_id", scanId)
      .eq("kind", "question")
      .select("routine_id");
    expect(error).toBeNull();
    expect(data).toEqual([{ routine_id: seeded.routineId }]);
  });

  it("nothing else on the bucket is theirs to change", async () => {
    const { error } = await ada.db
      .from("arrival_buckets")
      .update({ label: "Something else" })
      .eq("scan_id", scanId)
      .eq("kind", "question");
    expect(error?.code).toBe("42501");
  });

  it("a teammate cannot record one on somebody else's bucket", async () => {
    const { data } = await linus.db
      .from("arrival_buckets")
      .update({ routine_id: null })
      .eq("scan_id", scanId)
      .select("kind");
    expect(data ?? []).toEqual([]);
  });

  it("only a routine of the owner's own can be recorded", async () => {
    const other = await seedWorkspace(grace);
    const { data, error } = await ada.db
      .from("arrival_buckets")
      .update({ routine_id: other.routineId })
      .eq("scan_id", scanId)
      .eq("kind", "question")
      .select("kind");
    expect(data ?? []).toEqual([]);
    expect(error).not.toBeNull();
  });
});

describe("an API-key token", () => {
  it("reads nothing, even in the key's own workspace", async () => {
    let seen: number | undefined;
    try {
      await sql().begin(async (tx) => {
        const claims = { sub: ada.id, role: "authenticated", covan_ws: ada.workspaceId };
        await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
        await tx`set local role authenticated`;
        const [row] = await tx`select count(*)::int as n from public.arrival_scans`;
        seen = row.n as number;
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    expect(seen).toBe(0);
  });
});

describe("the public internet", () => {
  it("reads nothing", async () => {
    const { data, error } = await anonClient().from("arrival_scans").select("id");
    expect(error !== null || (data ?? []).length === 0).toBe(true);
  });
});
