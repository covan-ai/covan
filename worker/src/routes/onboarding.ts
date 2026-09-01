import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { ROLES, USE_CASES, TEAM_SIZES, REFERRAL_SOURCES } from "../lib/onboarding";
import { welcomeEmail } from "../lib/emails/welcome";
import { appUrlOf, notify } from "../lib/emails/send";

const onboarding = new Hono<AppEnv>();

const updateSchema = z
  .object({
    role: z.enum(ROLES).optional(),
    useCase: z.enum(USE_CASES).optional(),
    teamSize: z.enum(TEAM_SIZES).optional(),
    referralSource: z.enum(REFERRAL_SOURCES).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "at least one answer is required",
  });

type AnswersRow = {
  role: string | null;
  use_case: string | null;
  team_size: string | null;
  referral_source: string | null;
};

function toAnswers(row: AnswersRow) {
  return {
    role: row.role,
    useCase: row.use_case,
    teamSize: row.team_size,
    referralSource: row.referral_source,
  };
}

const ANSWER_COLUMNS = "role, use_case, team_size, referral_source";

// PATCH /onboarding — record one answer, or several.
//
// One field per tap rather than a batch at the end of the survey: someone who
// abandons on the second question keeps the first answer, and comes back to the
// question they stopped on. The requests are three small writes, not a form.
//
// Upsert rather than update, because the first answer is also the first row.
// Written through the caller's own client, so the insert and update policies
// are what enforce "your own" — `user_id` comes from the verified token and
// never from the body, so there is nothing here to forge.
onboarding.patch("/onboarding", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const row: Record<string, unknown> = {
    user_id: user.id,
    updated_at: new Date().toISOString(),
  };
  if (parsed.data.role !== undefined) row.role = parsed.data.role;
  if (parsed.data.useCase !== undefined) row.use_case = parsed.data.useCase;
  if (parsed.data.teamSize !== undefined) row.team_size = parsed.data.teamSize;
  if (parsed.data.referralSource !== undefined) row.referral_source = parsed.data.referralSource;

  const { data, error } = await db
    .from("user_onboarding")
    .upsert(row, { onConflict: "user_id" })
    .select(ANSWER_COLUMNS)
    .maybeSingle();

  // No row means RLS refused, not that the answer was already correct. An
  // upsert that matches nothing must not report success.
  if (error || !data) {
    console.error("failed to save onboarding answer", error);
    return c.json({ error: "failed to save your answer" }, 500);
  }

  return c.json(toAnswers(data as AnswersRow));
});

// POST /onboarding/complete — the first run is over.
//
// A separate verb rather than a `completed` field on PATCH: completion is a
// state transition, not something the client owns. As a field, any caller could
// un-complete it or re-stamp it.
//
// Idempotent by reading first. Skipping out of the wizard and finishing it
// properly both end here, and neither should move a stamp that already exists.
onboarding.post("/onboarding/complete", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const { data: existing, error: readError } = await db
    .from("user_onboarding")
    .select("completed_at")
    .eq("user_id", user.id)
    .maybeSingle();

  if (readError) {
    console.error("failed to read onboarding state", readError);
    return c.json({ error: "failed to finish onboarding" }, 500);
  }

  if (existing?.completed_at) {
    return c.json({ completed: true });
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("user_onboarding")
    .upsert({ user_id: user.id, completed_at: now, updated_at: now }, { onConflict: "user_id" })
    .select("completed_at")
    .maybeSingle();

  if (error || !data) {
    console.error("failed to finish onboarding", error);
    return c.json({ error: "failed to finish onboarding" }, 500);
  }

  // After the stamp, and only on the path that wrote one: the early return above
  // is what keeps a reload of the last step from being a second welcome.
  if (user.email) {
    notify(c, welcomeEmail({ email: user.email, appUrl: appUrlOf(c) }));
  }

  return c.json({ completed: true });
});

export { onboarding };
