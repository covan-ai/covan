/**
 * Shared plumbing for the RLS suite.
 *
 * These tests exist because tenant isolation in Covan is enforced by Postgres,
 * not by application code — see the comment on `authMiddleware` in
 * worker/src/middleware/auth.ts. Every route hands the caller's bearer token to
 * a request-scoped Supabase client so `auth.uid()` resolves to the caller, and
 * the policies in supabase/migrations decide what that caller may see. Nothing
 * in TypeScript checks those policies. A migration that forgets
 * `enable row level security` leaves every other test in the repo green.
 *
 * So the suite drives the real thing: real users created through GoTrue, real
 * JWTs, real requests through PostgREST. What passes here is what a browser
 * would get.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import postgres from "postgres";

export type StackConfig = {
  /** Supabase API gateway — GoTrue and PostgREST live behind it. */
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  /** Direct Postgres connection, for catalog queries and cleanup. */
  dbUrl: string;
};

/**
 * Resolves the stack to test against.
 *
 * Explicit environment variables win, so the suite can be pointed at whatever
 * is already running — the repo's own `docker compose` stack, for instance,
 * which binds the same port the Supabase CLI wants and therefore cannot run
 * alongside it. With nothing set, we ask the CLI, which is what CI does.
 */
function resolveConfig(): StackConfig {
  const fromEnv = {
    url: process.env.SUPABASE_TEST_URL,
    anonKey: process.env.SUPABASE_TEST_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_TEST_SERVICE_ROLE_KEY,
    dbUrl: process.env.SUPABASE_TEST_DB_URL,
  };

  if (fromEnv.url && fromEnv.anonKey && fromEnv.serviceRoleKey && fromEnv.dbUrl) {
    return fromEnv as StackConfig;
  }

  let raw: string;
  try {
    raw = execFileSync("supabase", ["status", "-o", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    throw new Error(
      "No database to test against. Either start the Supabase CLI stack with " +
        "`supabase start`, or point the suite at a running stack by setting " +
        "SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY, SUPABASE_TEST_SERVICE_ROLE_KEY " +
        "and SUPABASE_TEST_DB_URL. See CONTRIBUTING.md.",
      { cause },
    );
  }

  const status = JSON.parse(raw) as Record<string, string>;
  const missing = ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY", "DB_URL"].filter(
    (key) => !status[key],
  );
  if (missing.length > 0) {
    throw new Error(`\`supabase status\` did not report: ${missing.join(", ")}`);
  }

  return {
    url: status.API_URL,
    anonKey: status.ANON_KEY,
    serviceRoleKey: status.SERVICE_ROLE_KEY,
    dbUrl: status.DB_URL,
  };
}

let cached: StackConfig | undefined;

export function stackConfig(): StackConfig {
  cached ??= resolveConfig();
  return cached;
}

/** Never persists a session: each client here must carry exactly one identity. */
const CLIENT_OPTIONS = { auth: { persistSession: false, autoRefreshToken: false } } as const;

/** Bypasses RLS. Used to set up fixtures the policies would not let a user create. */
export function serviceClient(): SupabaseClient {
  const { url, serviceRoleKey } = stackConfig();
  return createClient(url, serviceRoleKey, CLIENT_OPTIONS);
}

/** A caller with the anon key and no session at all — the public internet. */
export function anonClient(): SupabaseClient {
  const { url, anonKey } = stackConfig();
  return createClient(url, anonKey, CLIENT_OPTIONS);
}

let sqlClient: ReturnType<typeof postgres> | undefined;

/** Direct superuser connection. Only for catalog reads and teardown. */
export function sql() {
  sqlClient ??= postgres(stackConfig().dbUrl, { max: 1, onnotice: () => {} });
  return sqlClient;
}

export async function closeSql() {
  await sqlClient?.end({ timeout: 5 });
  sqlClient = undefined;
}

export type TestUser = {
  id: string;
  email: string;
  /**
   * Supabase client carrying this user's real JWT. This is the same shape the
   * API's `userClient` builds per request, so what these tests observe is what
   * a route observes.
   */
  db: SupabaseClient;
  /** The workspace the signup trigger created, where this user is 'admin'. */
  workspaceId: string;
};

const created: string[] = [];

/**
 * Creates a confirmed user and signs them in.
 *
 * Deliberately uses the admin API rather than `signUp`, so the suite does not
 * depend on whether email confirmation happens to be enabled in the stack it is
 * pointed at. The `on_auth_user_created` trigger still fires, which is what
 * gives the user a profile, a default workspace and an admin membership.
 */
export async function createTestUser(label: string): Promise<TestUser> {
  const service = serviceClient();
  const email = `rls-${label}-${crypto.randomUUID()}@covan.test`;
  const password = crypto.randomUUID();

  const { data: createdUser, error: createError } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: label },
  });
  if (createError || !createdUser.user) {
    throw new Error(`could not create ${label}: ${createError?.message}`);
  }
  created.push(createdUser.user.id);

  const { url, anonKey } = stackConfig();
  const db = createClient(url, anonKey, CLIENT_OPTIONS);
  const { error: signInError } = await db.auth.signInWithPassword({ email, password });
  if (signInError) {
    throw new Error(`could not sign ${label} in: ${signInError.message}`);
  }

  // The signup trigger is what creates this row; reading it back through the
  // user's own client doubles as a check that the trigger ran.
  const { data: membership, error: membershipError } = await db
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", createdUser.user.id)
    .maybeSingle();
  if (membershipError || !membership) {
    throw new Error(
      `signup trigger left ${label} without a workspace: ${membershipError?.message ?? "no row"}`,
    );
  }

  return { id: createdUser.user.id, email, db, workspaceId: membership.workspace_id };
}

/**
 * Removes every user this run created, and everything hanging off them.
 *
 * The workspaces go before the people, and that ordering is the whole of it.
 * Deleting a workspace cascades its memberships, its agents and everything
 * under them; deleting a user then cascades what was only ever theirs, and
 * nulls their name on anything left standing in someone else's workspace.
 *
 * `chat_sessions.workspace_id` and `ideas.workspace_id` are NO ACTION and so
 * still have to be cleared by hand first — that is a different arrangement from
 * the one 0016 dealt with, and unrelated to who is being deleted.
 *
 * This used to need `session_replication_role = replica` to get past
 * `trg_prevent_last_admin`, which refused to remove a workspace's last admin
 * even when the workspace itself was being deleted. 0016 taught the guard the
 * difference, so the workaround is gone; tests/rls/deletion.test.ts is what
 * keeps it gone.
 */
export async function destroyTestUsers() {
  if (created.length === 0) return;

  const db = sql();
  const ids = created.splice(0, created.length);
  const users = db.array(ids);

  await db.begin(async (tx) => {
    const workspaces = tx`select id from public.workspaces where created_by = any(${users}::uuid[])`;

    await tx`delete from public.ideas where workspace_id in (${workspaces})`;
    await tx`delete from public.chat_sessions where workspace_id in (${workspaces})`;
    await tx`delete from public.chat_sessions where user_id = any(${users}::uuid[])`;
    await tx`delete from public.workspaces where created_by = any(${users}::uuid[])`;
    await tx`delete from auth.users where id = any(${users}::uuid[])`;
  });
}
