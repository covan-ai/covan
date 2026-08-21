import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import type { MeDTO } from "../lib/dto";
import { getActiveWorkspaceId } from "../lib/workspace";

const me = new Hono<AppEnv>();

const updateProfileSchema = z.object({
  // Trimmed and bounded, because this name is rendered to the rest of the
  // workspace — on shared sessions, in the member list, on every message.
  name: z.string().trim().min(1).max(80),
});

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
    .select("id,name,slug,default_model")
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

  // No row is the normal state for a new account, not an error: the row appears
  // with the first answer. Either way the question is only ever "is there a
  // stamp", so a failed read is treated as unfinished rather than as a 500 —
  // refusing to serve /me over this would lock a working account out of the app.
  const { data: onboardingRow } = await db
    .from("user_onboarding")
    .select("completed_at, role, use_case, team_size, referral_source")
    .eq("user_id", user.id)
    .maybeSingle();

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
      defaultModel: (workspace.default_model as string | null) ?? null,
    },
    members,
    onboarding: {
      completed: Boolean(onboardingRow?.completed_at),
      answers: {
        role: (onboardingRow?.role as string | null) ?? null,
        useCase: (onboardingRow?.use_case as string | null) ?? null,
        teamSize: (onboardingRow?.team_size as string | null) ?? null,
        referralSource: (onboardingRow?.referral_source as string | null) ?? null,
      },
    },
  };

  return c.json(result);
});

// PATCH /me — change your own display name.
//
// Written through the caller's own client, so `profiles_update_own` is what
// enforces "your own": the row is matched on `id = auth.uid()` in Postgres, not
// by trusting the id in this handler. Nothing here can widen that.
me.patch("/me", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const parsed = updateProfileSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { data: updated, error } = await db
    .from("profiles")
    .update({ name: parsed.data.name })
    .eq("id", user.id)
    .select("id, name, email, avatar_url");

  if (error) {
    console.error("profile update failed", error);
    return c.json({ error: "failed to save your profile" }, 500);
  }
  // Zero rows means RLS refused, not that the name was already correct — an
  // update that matches nothing must not report success.
  if (!updated || updated.length === 0) {
    return c.json({ error: "failed to save your profile" }, 500);
  }

  const row = updated[0];
  return c.json({
    id: row.id as string,
    name: (row.name as string | null) ?? null,
    email: user.email ?? (row.email as string | null) ?? null,
    avatarUrl: (row.avatar_url as string | null) ?? null,
  });
});

export { me };
