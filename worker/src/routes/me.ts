import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { mapProfile, PROFILE_COLUMNS, type MeDTO, type ProfileRow } from "../lib/dto";
import { BCP47_RE, canonicalTimeZone } from "../lib/profile-fields";
import { callerWorkspaceId } from "../lib/workspace";
import { availableModels, modelSpecsFor } from "../lib/models";
import { modelCostsFor } from "../lib/pricing";

const me = new Hono<AppEnv>();

/** An empty string clears a field: that is what an emptied input sends. */
const blankToNull = (value: string | null) => (value === "" ? null : value);

const updateProfileSchema = z
  .object({
    // Trimmed and bounded, because this name is rendered to the rest of the
    // workspace — on shared sessions, in the member list, on every message.
    name: z.string().trim().min(1).max(80).optional(),
    // Counted in characters rather than UTF-16 units, the way the column's
    // `char_length` counts them, so a bio of emoji is not refused at half the
    // length the counter on the page promised.
    bio: z
      .string()
      .trim()
      .refine((value) => [...value].length <= 280, "at most 280 characters")
      .nullable()
      .optional(),
    locale: z
      .string()
      .trim()
      .max(35)
      .refine((value) => value === "" || BCP47_RE.test(value), "not a language tag")
      .nullable()
      .optional(),
    // Shape only here; whether the zone exists is the runtime's answer, below.
    timezone: z.string().trim().max(64).nullable().optional(),
  })
  // Strict, so `email` and `avatar_url` are refused by name rather than quietly
  // dropped: the first belongs to GoTrue and the trigger in 0082, the second to
  // the avatar routes, and a client that sends either has misunderstood which.
  .strict()
  .refine((body) => Object.keys(body).length > 0, "nothing to change");

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

  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) {
    return c.json({ error: "no workspace found for user" }, 404);
  }

  const { data: workspace, error: workspaceError } = await db
    .from("workspaces")
    .select("id,name,slug,default_model,gap_report_enabled")
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
    bio: string | null;
    timezone: string | null;
  };

  let profilesById = new Map<string, MemberProfile>();
  if (memberUserIds.length > 0) {
    const { data: profileRows, error: profilesError } = await db
      .from("profiles")
      // Named columns, not `*`: `locale` is the member's own preference and
      // stays off everybody else's copy of the list. The flip side is that
      // naming `bio` and `timezone` makes PostgREST refuse this read on a
      // database without 0082, which is why that migration deploys first.
      .select("id, name, email, avatar_url, bio, timezone")
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
          bio: (row.bio as string | null) ?? null,
          timezone: (row.timezone as string | null) ?? null,
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
        bio: memberProfile.bio,
        timezone: memberProfile.timezone,
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
    user: mapProfile({ ...(profile as ProfileRow), id: user.id }, user.email),
    workspace: {
      id: workspace.id as string,
      name: workspace.name as string,
      slug: workspace.slug as string,
      defaultModel: (workspace.default_model as string | null) ?? null,
      gapReportEnabled: workspace.gap_report_enabled === true,
    },
    members,
    models: availableModels(c.env),
    modelSpecs: modelSpecsFor(availableModels(c.env)),
    // Empty under a custom endpoint, where the picked id is not what answers.
    modelCosts: modelCostsFor(availableModels(c.env), c.env),
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

// PATCH /me — change what you say about yourself: name, bio, locale, timezone.
//
// Written through the caller's own client, so `profiles_update_own` is what
// enforces "your own": the row is matched on `id = auth.uid()` in Postgres, not
// by trusting the id in this handler. Nothing here can widen that. Only the keys
// the body carries are written, so a form that saves its bio does not also
// write back a name it read a minute ago over one changed in another tab.
me.patch("/me", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const parsed = updateProfileSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const patch: Record<string, string | null> = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.bio !== undefined) patch.bio = blankToNull(parsed.data.bio);
  if (parsed.data.locale !== undefined) patch.locale = blankToNull(parsed.data.locale);
  if (parsed.data.timezone !== undefined) {
    const raw = parsed.data.timezone;
    if (raw === null || raw === "") {
      patch.timezone = null;
    } else {
      const zone = canonicalTimeZone(raw);
      if (!zone) {
        // The same shape `flatten()` gives every other refusal here, so the
        // client reads one kind of 400.
        return c.json(
          { error: { formErrors: [], fieldErrors: { timezone: ["not a time zone"] } } },
          400,
        );
      }
      patch.timezone = zone;
    }
  }

  const { data: updated, error } = await db
    .from("profiles")
    .update(patch)
    .eq("id", user.id)
    .select(PROFILE_COLUMNS);

  if (error) {
    console.error("profile update failed", error);
    return c.json({ error: "failed to save your profile" }, 500);
  }
  // Zero rows means RLS refused, not that the fields were already correct — an
  // update that matches nothing must not report success.
  if (!updated || updated.length === 0) {
    return c.json({ error: "failed to save your profile" }, 500);
  }

  return c.json(mapProfile(updated[0] as ProfileRow, user.email));
});

export { me };
