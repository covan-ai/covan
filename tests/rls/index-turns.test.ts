/**
 * A workspace indexes one document at a time (0111).
 *
 * The rule is in the claim, which is SQL, and its hardest case — two documents
 * claimed in the same moment — is a race only a real database can run. So
 * every promise 0111 makes is checked here: a document waits while another in
 * its workspace is leased or part-way, the older of two part-way documents
 * carries on, a finished one lets the next through, another workspace is never
 * held up, the cron skips a document whose turn has not come, and of two
 * claims at once exactly one wins.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  sql,
  type TestUser,
} from "./harness";
import { seedWorkspace, type Seeded } from "./fixtures";

let owner: TestUser;
let other: TestUser;
let mine: Seeded;
let theirs: Seeded;
const made: string[] = [];

/** Only the job writes the index columns, so the fixture uses the service role. */
async function doc(
  bundleId: string,
  status: "queued" | "indexing" | "ready" | "failed",
  over: Record<string, unknown> = {},
): Promise<string> {
  const { data, error } = await serviceClient()
    .from("documents")
    .insert({
      bundle_id: bundleId,
      name: `book-${made.length}.pdf`,
      content: "",
      index_status: status,
      index_next_run_at: new Date(Date.now() - 1_000).toISOString(),
      ...over,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seeding a document failed: ${error?.message}`);
  made.push(data.id as string);
  return data.id as string;
}

async function claim(documentId: string): Promise<boolean> {
  const { data, error } = await serviceClient().rpc("claim_index_job", {
    p_document_id: documentId,
  });
  if (error) throw new Error(`claim_index_job failed: ${error.message}`);
  return (data as unknown[]).length === 1;
}

async function set(documentId: string, values: Record<string, unknown>) {
  const { error } = await serviceClient().from("documents").update(values).eq("id", documentId);
  if (error) throw new Error(`updating a document failed: ${error.message}`);
}

const ago = (s: number) => new Date(Date.now() - s * 1_000).toISOString();

beforeAll(async () => {
  owner = await createTestUser("index-turns-owner");
  other = await createTestUser("index-turns-other");
  mine = await seedWorkspace(owner);
  theirs = await seedWorkspace(other);
});

afterEach(async () => {
  if (made.length === 0) return;
  await serviceClient().from("documents").delete().in("id", made.splice(0));
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("claim_index_job", () => {
  it("lets the first of two uploads start, and holds the second while the first is leased", async () => {
    const first = await doc(mine.bundleId, "queued");
    const second = await doc(mine.bundleId, "queued");

    expect(await claim(first)).toBe(true);
    expect(await claim(second)).toBe(false);
  });

  it("holds a queued document while another is part-way, between its units", async () => {
    const running = await doc(mine.bundleId, "indexing", { index_lease_until: null });
    const next = await doc(mine.bundleId, "queued");

    expect(await claim(next)).toBe(false);
    expect(await claim(running)).toBe(true);
  });

  it("lets the next one through once the running one is finished — or failed", async () => {
    const running = await doc(mine.bundleId, "indexing");
    const next = await doc(mine.bundleId, "queued");
    expect(await claim(next)).toBe(false);

    await set(running, { index_status: "failed" });

    expect(await claim(next)).toBe(true);
  });

  it("does not wait for a deleted document", async () => {
    const binned = await doc(mine.bundleId, "indexing", { deleted_at: ago(5) });
    const next = await doc(mine.bundleId, "queued");

    expect(await claim(next)).toBe(true);
    expect(await claim(binned)).toBe(false);
  });

  // Two part-way documents — from before 0111, or one that started while the
  // other held a lease for a moment — must not wait for each other for ever.
  it("carries on with the older of two part-way documents and holds the younger", async () => {
    const older = await doc(mine.bundleId, "indexing", { created_at: ago(600) });
    const younger = await doc(mine.bundleId, "indexing", { created_at: ago(60) });

    expect(await claim(younger)).toBe(false);
    expect(await claim(older)).toBe(true);
  });

  // A clock that died holding a lease must not hold the workspace for good.
  it("does not wait for a lease that has run out", async () => {
    const stale = await doc(mine.bundleId, "queued", { index_lease_until: ago(1) });
    const next = await doc(mine.bundleId, "queued");

    // The stale lease holds nothing, and the document it was on is not
    // part-way, so either may start: the first claim wins.
    expect(await claim(next)).toBe(true);
    expect(await claim(stale)).toBe(false);
  });

  it("never holds up another workspace", async () => {
    await doc(mine.bundleId, "indexing");
    const elsewhere = await doc(theirs.bundleId, "queued");

    expect(await claim(elsewhere)).toBe(true);
  });

  // The race the advisory lock is for: without it both claims see nobody
  // leased or part-way, and both start.
  // A race is not lost every time it is run, so it is run several times.
  it("lets exactly one of two claims made at the same moment through", async () => {
    for (let round = 0; round < 8; round++) {
      const a = await doc(mine.bundleId, "queued");
      const b = await doc(mine.bundleId, "queued");

      const won = await Promise.all([claim(a), claim(b), claim(a), claim(b)]);

      expect(won.filter(Boolean)).toHaveLength(1);
      await set(a, { index_status: "ready", index_lease_until: null });
      await set(b, { index_status: "ready", index_lease_until: null });
    }
  });
});

describe("claim_due_index_jobs", () => {
  it("skips a document whose turn has not come and takes one whose turn has", async () => {
    const running = await doc(mine.bundleId, "indexing", { index_lease_until: null });
    const held = await doc(mine.bundleId, "queued");
    const elsewhere = await doc(theirs.bundleId, "queued");

    const { data, error } = await serviceClient().rpc("claim_due_index_jobs", { p_limit: 50 });
    expect(error).toBeNull();
    const ids = (data as Array<{ id: string }>).map((d) => d.id);

    expect(ids).toContain(running);
    expect(ids).toContain(elsewhere);
    expect(ids).not.toContain(held);
  });
});

describe("index_job_waits", () => {
  it.each(["anon", "authenticated"])("cannot be called by %s", async (role) => {
    const rows = await sql()`
      select has_function_privilege(${role}, 'public.index_job_waits(public.documents, uuid)', 'execute') as can
    `;
    expect(rows[0].can).toBe(false);
  });
});
