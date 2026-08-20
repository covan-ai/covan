import { Hono } from "hono";
import type { AppEnv } from "../types";
import type { MeDTO } from "../lib/dto";
import { getActiveWorkspaceId } from "../lib/workspace";

const me = new Hono<AppEnv>();

// GET /me
me.get("/me", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const { data: profile, error: profileError } = await db
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
    return c.json({ error: "failed to load profile" }, 500);
  }

  const workspaceId = await getActiveWorkspaceId(db, user.id);
  if (!workspaceId) {
    return c.json({ error: "no workspace found for user" }, 404);
  }

  const { data: workspace, error: workspaceError } = await db
    .from("workspaces")
    .select("id,name,slug")
    .eq("id", workspaceId)
    .single();

  if (workspaceError || !workspace) {
    return c.json({ error: "failed to load workspace" }, 500);
  }

  // No direct FK exists between workspace_members and profiles (both only
  // reference auth.users), so PostgREST cannot infer an embedded join.
  // Fetch memberships and profiles separately, then join in JS.
  const { data: memberRows, error: membersError } = await db
    .from("workspace_members")
    .select("user_id, role")
    .eq("workspace_id", workspaceId);

  if (membersError) {
    return c.json({ error: "failed to load members" }, 500);
  }

  const memberships: Array<{ user_id: string; role: string }> = (memberRows ?? []).map((row) => ({
    user_id: row.user_id as string,
    role: row.role as string,
  }));

  const memberUserIds = memberships.map((m) => m.user_id);

  type MemberProfile = {
    id: string;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
  };

  let profilesById = new Map<string, MemberProfile>();
  if (memberUserIds.length > 0) {
    const { data: profileRows, error: profilesError } = await db
      .from("profiles")
      .select("id, name, email, avatar_url")
      .in("id", memberUserIds);

    if (profilesError) {
      return c.json({ error: "failed to load members" }, 500);
    }

    profilesById = new Map(
      (profileRows ?? []).map((row) => [
        row.id as string,
        {
          id: row.id as string,
          name: (row.name as string | null) ?? null,
          email: (row.email as string | null) ?? null,
          avatar_url: (row.avatar_url as string | null) ?? null,
        },
      ]),
    );
  }

  const members = memberships
    .map((membership) => {
      const memberProfile = profilesById.get(membership.user_id);
      if (!memberProfile) return null;
      return {
        id: memberProfile.id,
        name: memberProfile.name,
        email: memberProfile.email,
        role: membership.role,
        avatarUrl: memberProfile.avatar_url,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  const result: MeDTO = {
    user: {
      id: user.id,
      name: (profile.name as string | null) ?? null,
      email: user.email ?? (profile.email as string | null) ?? null,
      avatarUrl: (profile.avatar_url as string | null) ?? null,
    },
    workspace: {
      id: workspace.id as string,
      name: workspace.name as string,
      slug: workspace.slug as string,
    },
    members,
  };

  return c.json(result);
});

export { me };
