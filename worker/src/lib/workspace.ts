import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Resolves the caller's *active* workspace id.
 *
 * Reads `profiles.active_workspace_id`; if it's set AND the caller is still a
 * member of it, returns it. Otherwise falls back to the caller's oldest
 * membership (deterministic), best-effort persists that as the new active
 * workspace, and returns it. Returns null only if the caller has no memberships.
 *
 * RLS scopes both reads to the caller's own rows.
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
