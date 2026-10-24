import { preparePassages } from "../../src/lib/bearings";
import { insertChunkRows } from "../../src/lib/chunk-store";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Embedder } from "./embed-cache";

/**
 * The stack, from the same variables `tests/rls/` reads and CI's `rls` job
 * sets. Not imported from `tests/rls/harness.ts`: that file resolves the root
 * package's supabase-js, a different version from the worker's, and the two
 * clients do not type-check as one another.
 */
function stack() {
  const url = process.env.SUPABASE_TEST_URL ?? "";
  const anonKey = process.env.SUPABASE_TEST_ANON_KEY ?? "";
  const serviceRoleKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? "";
  return { url, anonKey, serviceRoleKey };
}

const CLIENT_OPTIONS = { auth: { persistSession: false, autoRefreshToken: false } } as const;

function serviceClient(): SupabaseClient {
  const { url, serviceRoleKey } = stack();
  return createClient(url, serviceRoleKey, CLIENT_OPTIONS);
}

export type TestUser = { id: string; db: SupabaseClient; workspaceId: string };

const created: TestUser[] = [];

/**
 * A confirmed user, signed in, with the workspace the signup trigger gives
 * everybody — the same steps as `tests/rls/harness.ts`'s `createTestUser`.
 */
async function createTestUser(label: string): Promise<TestUser> {
  const service = serviceClient();
  const email = `bench-${label}-${crypto.randomUUID()}@covan.test`;
  const password = crypto.randomUUID();
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`could not create ${label}: ${error?.message}`);

  const { url, anonKey } = stack();
  const db = createClient(url, anonKey, CLIENT_OPTIONS);
  const { error: signInError } = await db.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`could not sign ${label} in: ${signInError.message}`);

  const { data: membership, error: membershipError } = await db
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (membershipError || !membership) {
    throw new Error(`signup left ${label} without a workspace: ${membershipError?.message}`);
  }
  const user = { id: data.user.id, db, workspaceId: membership.workspace_id as string };
  created.push(user);
  return user;
}

/**
 * The corpus, brought up in the repo's own docker stack — the one `tests/rls/`
 * runs against — as one person's workspace: an agent, one shared bundle, every
 * document in it, every passage prepared the way the indexing job prepares it.
 *
 * Through that person's own client wherever the app uses one, so the search
 * the runner asks is the search a person's chat turn asks, policies and all.
 */
export type SeededCorpus = { user: TestUser; agentId: string; bundleId: string; passages: number };

async function insertId(user: TestUser, table: string, values: Record<string, unknown>) {
  const { data, error } = await user.db.from(table).insert(values).select("id").single();
  if (error) throw new Error(`seeding ${table} failed: ${error.message}`);
  return data.id as string;
}

export async function seedCorpus(
  docs: { name: string; text: string }[],
  embed: Embedder,
): Promise<SeededCorpus> {
  const user = await createTestUser("retrieval-bench");
  const agentId = await insertId(user, "agents", {
    workspace_id: user.workspaceId,
    name: "Benchmark agent",
    created_by: user.id,
  });
  const bundleId = await insertId(user, "knowledge_bundles", {
    workspace_id: user.workspaceId,
    name: "Benchmark corpus",
    created_by: user.id,
    scope: "workspace",
  });

  // Without this row the search's bundle narrowing is empty and every case
  // finds nothing for a reason unrelated to ranking — the gap
  // `tests/rls/hybrid-retrieval.test.ts` describes. The service role, as there.
  const { error: linkError } = await serviceClient()
    .from("agent_bundles")
    .insert({ agent_id: agentId, bundle_id: bundleId });
  if (linkError) throw new Error(`could not attach the corpus to the agent: ${linkError.message}`);

  let passages = 0;
  // In order, one at a time: insertion order is what makes the newer of two
  // versions the newer document.
  for (const doc of docs) {
    const documentId = await insertId(user, "documents", {
      bundle_id: bundleId,
      name: doc.name,
      content: doc.text,
    });
    const prepared = preparePassages(doc.name, doc.text);
    const vectors = await embed(prepared.map((p) => p.embedInput));
    const { error } = await insertChunkRows(
      user.db,
      prepared.map((p, i) => ({
        document_id: documentId,
        bundle_id: bundleId,
        workspace_id: user.workspaceId,
        chunk_index: i,
        content: p.content,
        context: doc.name,
        embedding: vectors[i],
      })),
      null,
    );
    if (error) throw new Error(`could not save passages of ${doc.name}: ${JSON.stringify(error)}`);
    passages += prepared.length;
  }

  return { user, agentId, bundleId, passages };
}

/**
 * Removes the benchmark's users and everything under their workspaces. The
 * workspace first — it cascades the agent, the bundle, the documents and
 * their passages — then the person, as `tests/rls/harness.ts` orders it.
 */
export async function teardown(): Promise<void> {
  const service = serviceClient();
  for (const user of created.splice(0)) {
    const { error } = await service.from("workspaces").delete().eq("id", user.workspaceId);
    if (error) console.error(`could not remove workspace ${user.workspaceId}: ${error.message}`);
    const { error: userError } = await service.auth.admin.deleteUser(user.id);
    if (userError) console.error(`could not remove user ${user.id}: ${userError.message}`);
  }
}
