import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestUser, serviceClient, sql, closeSql, type TestUser } from "./harness";
import { seedWorkspace } from "./fixtures";
import { collectWorkspace, type Collected } from "../../worker/src/lib/export/collect";
import { renderSql } from "../../worker/src/lib/export/sql";

/**
 * Export a workspace, destroy it, put it back, and count.
 *
 * Everything else about the export is unit-tested against fakes, and fakes
 * cannot answer the only question that matters here: whether `workspace.sql`
 * actually replays. A foreign key the renderer got in the wrong order, a jsonb
 * column quoted as text, a person column nobody noticed pointed at `profiles`
 * instead of `auth.users` — none of those fail against a mock. They fail
 * against Postgres, once, loudly, and only if something runs them.
 *
 * The round trip is done in the same database rather than a second one. That is
 * not a shortcut: it means the restore has to survive the workspace genuinely
 * being gone, which is a stronger claim than inserting into an empty schema
 * where nothing could have collided. And it uses a *different* account as the
 * owner, so the remap is exercised rather than accidentally being a no-op.
 *
 * What it deliberately does not test is `psql` expanding `:'owner'`. The
 * substitution is done here so the suite needs no `psql` binary; the shape of
 * what psql would produce — a quoted literal — is what is written in.
 */

let owner: TestUser;
let restorer: TestUser;
let workspaceId: string;
let before: Collected;
let script: string;

/** Row counts per table, which is the comparison the whole test is about. */
const counts = (tables: Collected) =>
  Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, rows.length]));

beforeAll(async () => {
  owner = await createTestUser("export-owner");
  restorer = await createTestUser("export-restorer");
  workspaceId = owner.workspaceId;

  const seeded = await seedWorkspace(owner);

  // Two tables the shared fixture does not reach, added here so the round trip
  // covers every join table the export declares.
  const service = serviceClient();
  const { error: linkError } = await service
    .from("agent_bundles")
    .insert({ agent_id: seeded.agentId, bundle_id: seeded.bundleId });
  if (linkError) throw new Error(`seeding agent_bundles failed: ${linkError.message}`);

  const { error: favError } = await owner.db
    .from("favorites")
    .insert({ user_id: owner.id, agent_id: seeded.agentId });
  if (favError) throw new Error(`seeding favorites failed: ${favError.message}`);

  before = await collectWorkspace(owner.db, workspaceId);
  script = renderSql(before).sql;
});

afterAll(async () => {
  await closeSql();
});

describe("what the export saw", () => {
  it("is a whole workspace, not an empty one", () => {
    // Guards every assertion below. Comparing zero against zero passes.
    expect(counts(before)).toMatchObject({
      workspaces: 1,
      workspace_members: 1,
      agents: 1,
      knowledge_bundles: 1,
      agent_bundles: 1,
      documents: 1,
      chat_sessions: 1,
      messages: 1,
      ideas: 1,
      favorites: 1,
      delivery_channels: 1,
      routines: 1,
    });
  });

  it("never carries the encrypted delivery secret", async () => {
    // The column is real and populated — the fixture writes one — so this is a
    // check that the export did not read it, not that there was nothing to read.
    const [row] = await sql()`
      select secret_ciphertext from delivery_channels where workspace_id = ${workspaceId}
    `;
    expect(row.secret_ciphertext).toBeTruthy();
    expect(Object.keys(before.delivery_channels[0])).not.toContain("secret_ciphertext");
  });
});

describe("the restore", () => {
  it("puts back every row the export took", async () => {
    const service = serviceClient();

    // Cleared before the workspace, and this is not incidental: neither
    // reference cascades, so `delete from workspaces` fails the foreign key
    // while a single session or idea remains. The same order `routes/account.ts`
    // learned the hard way.
    for (const table of ["ideas", "chat_sessions"] as const) {
      const { error } = await service.from(table).delete().eq("workspace_id", workspaceId);
      if (error) throw new Error(`clearing ${table} failed: ${error.message}`);
    }
    const { error: dropError } = await service.from("workspaces").delete().eq("id", workspaceId);
    if (dropError) throw new Error(`deleting the workspace failed: ${dropError.message}`);

    const [gone] = await sql()`select count(*)::int as n from workspaces where id = ${workspaceId}`;
    expect(gone.n, "the workspace should be gone before the restore proves anything").toBe(0);

    // What psql's `-v owner=...` would expand `:'owner'` to.
    await sql()
      .unsafe(script.replaceAll(":'owner'", `'${restorer.id}'`))
      .simple();

    // Read back as the account that now owns it, which is the only account that
    // can see it — proof in itself that the membership row was rewritten.
    const after = await collectWorkspace(restorer.db, workspaceId);
    expect(counts(after)).toEqual(counts(before));
  });

  it("hands the workspace to the account that ran it, as an admin", async () => {
    const after = await collectWorkspace(restorer.db, workspaceId);

    expect(after.workspace_members).toHaveLength(1);
    expect(after.workspace_members[0]).toMatchObject({
      user_id: restorer.id,
      role: "admin",
    });
  });

  it("leaves nothing pointing at the account that took the export", async () => {
    // The failure this catches is a person column nobody added to USER_COLUMNS:
    // it would restore fine here, because the old account still exists in this
    // database, and dangle in the fresh install where it matters.
    const [row] = await sql()`
      select
        (select count(*) from agents where workspace_id = ${workspaceId} and created_by = ${owner.id}) +
        (select count(*) from chat_sessions where workspace_id = ${workspaceId} and user_id = ${owner.id}) +
        (select count(*) from messages m join chat_sessions s on s.id = m.session_id
           where s.workspace_id = ${workspaceId} and m.sender_id = ${owner.id}) +
        (select count(*) from routines where workspace_id = ${workspaceId} and user_id = ${owner.id})
        as n
    `;
    expect(Number(row.n)).toBe(0);
  });

  it("keeps the content itself, not just the row count", async () => {
    const after = await collectWorkspace(restorer.db, workspaceId);

    expect(after.messages[0].content).toBe(before.messages[0].content);
    expect(after.documents[0].name).toBe(before.documents[0].name);
    expect(after.routines[0].source_config).toEqual(before.routines[0].source_config);
    expect(after.agents[0].id).toBe(before.agents[0].id);
  });

  it("can be run twice without doubling anything", async () => {
    // `on conflict do nothing` throughout, so a restore interrupted half way
    // can simply be run again — the case somebody will actually hit.
    await sql()
      .unsafe(script.replaceAll(":'owner'", `'${restorer.id}'`))
      .simple();

    const after = await collectWorkspace(restorer.db, workspaceId);
    expect(counts(after)).toEqual(counts(before));
  });
});
