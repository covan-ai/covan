import type { SupabaseClient } from "@supabase/supabase-js";
import type { Context } from "hono";
import type { AppEnv } from "../types";

/**
 * The workspace a request acts in. Every route asks this, not
 * `getActiveWorkspaceId`.
 *
 * A browser session acts in whichever workspace its person last chose. An API
 * key acts in the workspace it was made in, whatever the owner has chosen
 * since -- and never runs the fallback below, which would write the owner's
 * profile on a script's behalf. Without this a key reached every workspace its
 * owner belongs to, and `POST /workspace/active` (refused to keys now) moved
 * it between them.
 *
 * The middleware has already refused a key whose owner is no longer a member
 * of that workspace, and Postgres refuses the rest: the token minted for a key
 * names the workspace, and the membership helpers answer "no" to any other.
 */
export async function callerWorkspaceId(c: Context<AppEnv>): Promise<string | null> {
  const keyWorkspace = c.get("apiKeyWorkspaceId");
  if (keyWorkspace) return keyWorkspace;
  return getActiveWorkspaceId(c.get("db"), c.get("user").id);
}

/**
 * Resolves the caller's *active* workspace id.
 *
 * Reads `profiles.active_workspace_id`; if it's set AND the caller is still a
 * member of it, returns it. Otherwise falls back to the caller's oldest
 * membership (deterministic), best-effort persists that as the new active
 * workspace, and returns it. Returns null only if the caller has no memberships.
 *
 * RLS scopes both reads to the caller's own rows.
 *
 * A session's answer only. Routes ask `callerWorkspaceId`, which knows that a
 * key's answer is fixed; `workspace-lock.static.test.ts` keeps it that way.
 */
export async function getActiveWorkspaceId(
  db: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data: profile } = await db
    .from("profiles")
    .select("active_workspace_id")
    .eq("id", userId)
    .maybeSingle();

  const activeId = (profile?.active_workspace_id as string | null) ?? null;

  if (activeId) {
    const { data: membership } = await db
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", userId)
      .eq("workspace_id", activeId)
      .maybeSingle();
    if (membership) {
      return activeId;
    }
  }

  // Fallback: oldest membership (deterministic).
  const { data: oldest, error } = await db
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !oldest) {
    return null;
  }

  const resolved = oldest.workspace_id as string;

  // Best-effort: remember it as the active workspace. Ignore failures.
  if (resolved !== activeId) {
    await db.from("profiles").update({ active_workspace_id: resolved }).eq("id", userId);
  }

  return resolved;
}

/**
 * The caller's role in a workspace, or null if they are not a member.
 *
 * Several routes were each asking this question with their own copy of the
 * same four lines — `tool-connections.ts` to keep a viewer from connecting a
 * service among them. One copy, so "what counts as a member" cannot drift
 * between them.
 *
 * Through the caller's own client, so RLS answers it. Not a permission check
 * in itself: it reports a fact, and each route decides what that fact means.
 */
export async function memberRole(
  db: SupabaseClient,
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  const { data } = await db
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  return (data?.role as string | null) ?? null;
}
