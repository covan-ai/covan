import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import {
  ASSISTANT_NAME_MAX,
  MAX_EVENTS_PER_BATCH,
  MAX_TOOLS,
  MODES,
  PURPOSES,
  REFERRAL_SOURCES,
  ROLES,
  STEP_EVENTS,
  STEP_ID,
  TEAM_SIZES,
  TOOL_SLUG,
  USE_CASES,
} from "../lib/onboarding";
import { AVATAR_MARKS, mapOnboarding, ONBOARDING_COLUMNS, type OnboardingRow } from "../lib/dto";
import { availableModels, MODEL_IDS } from "../lib/models";
import { callerWorkspaceId } from "../lib/workspace";
import { refuseIfKeyAuthenticated } from "../lib/api-key-rule";
import { welcomeEmail } from "../lib/emails/welcome";
import { appUrlOf, notify } from "../lib/emails/send";

const onboarding = new Hono<AppEnv>();

const updateSchema = z
  .object({
    // The old survey. Nothing asks these any more, but a row that carries them
    // can still be read back, and refusing the keys would turn an older client
    // mid-run into a wall of 400s.
    role: z.enum(ROLES).optional(),
    useCase: z.enum(USE_CASES).optional(),
    teamSize: z.enum(TEAM_SIZES).optional(),
    referralSource: z.enum(REFERRAL_SOURCES).optional(),
    // The run that introduces itself (0119).
    assistantName: z.string().trim().min(1).max(ASSISTANT_NAME_MAX).optional(),
    // Bounded in UTF-16 units: a flag or a family emoji is up to eleven of
    // them. Whitespace is refused because it is the one thing an emoji picker
    // cannot produce and a pasted sentence always does.
    assistantEmoji: z
      .string()
      .trim()
      .min(1)
      .max(16)
      .refine((value) => !/\s/.test(value), "not an emoji")
      .optional(),
    assistantRole: z.string().regex(STEP_ID).optional(),
    // The first run's agent step (0137): one of the eight marks, and the jobs
    // picked from its chips, order kept and repeats dropped.
    assistantAvatar: z.enum(AVATAR_MARKS).optional(),
    assistantJobs: z
      .array(z.string().regex(STEP_ID))
      .max(8)
      .transform((list) => [...new Set(list)])
      .optional(),
    // Deduplicated with the order kept: `tools[0]` is the one the assistant
    // proposes connecting first, so the order is part of the answer.
    tools: z
      .array(z.string().regex(TOOL_SLUG))
      .max(MAX_TOOLS)
      .transform((list) => [...new Set(list)])
      .optional(),
    purpose: z.enum(PURPOSES).optional(),
    mode: z.enum(MODES).optional(),
    lastStep: z.string().regex(STEP_ID).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "at least one answer is required",
  });

/** Body key → column. Explicit, so a new field cannot reach PostgREST under a name that misses. */
const COLUMN_OF = {
  role: "role",
  useCase: "use_case",
  teamSize: "team_size",
  referralSource: "referral_source",
  assistantName: "assistant_name",
  assistantEmoji: "assistant_emoji",
  assistantRole: "assistant_role",
  assistantAvatar: "assistant_avatar",
  assistantJobs: "assistant_jobs",
  tools: "tools",
  purpose: "purpose",
  mode: "mode",
  lastStep: "last_step",
} as const satisfies Record<keyof z.infer<typeof updateSchema>, string>;

// GET /onboarding — the caller's own answers and whether they finished.
//
// /me carries the same thing, and is what the app reads. This exists for the
// one caller /me cannot answer: an account with no workspace yet (0115), whose
// /me is a 404 but whose answers are theirs regardless of any workspace.
onboarding.get("/onboarding", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const { data, error } = await db
    .from("user_onboarding")
    .select(ONBOARDING_COLUMNS)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return c.json({ error: "failed to load onboarding" }, 500);

  return c.json(mapOnboarding(data as OnboardingRow | null));
});

// PATCH /onboarding — record one answer, or several.
//
// One field per tap rather than a batch at the end: someone who abandons on
// the second screen keeps the first answer, and `lastStep` brings them back to
// the screen they stopped on. The requests are small writes, not a form.
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
  for (const [key, column] of Object.entries(COLUMN_OF) as Array<
    [keyof typeof COLUMN_OF, string]
  >) {
    const value = parsed.data[key];
    if (value !== undefined) row[column] = value;
  }

  const { data, error } = await db
    .from("user_onboarding")
    .upsert(row, { onConflict: "user_id" })
    .select(ONBOARDING_COLUMNS)
    .maybeSingle();

  // No row means RLS refused, not that the answer was already correct. An
  // upsert that matches nothing must not report success.
  if (error || !data) {
    console.error("failed to save onboarding answer", error);
    return c.json({ error: "failed to save your answer" }, 500);
  }

  return c.json(mapOnboarding(data as OnboardingRow));
});

const eventsSchema = z.object({
  events: z
    .array(
      z.object({
        step: z.string().regex(STEP_ID),
        event: z.enum(STEP_EVENTS),
        at: z.string().datetime(),
        // A day. Longer than that is a tab left open, not a step taken.
        elapsedMs: z.number().int().min(0).max(86_400_000).optional(),
        clientId: z.string().uuid().optional(),
      }),
    )
    .min(1)
    .max(MAX_EVENTS_PER_BATCH),
});

// POST /onboarding/events — what happened on the way in, in a batch.
//
// Each step seen, finished or skipped, with how long it took. Kept in a table
// of our own (0119) rather than sent anywhere: the privacy page says no third
// party watches, and this is what makes the funnel readable without one.
//
// Batched because the client flushes on step changes and on `pagehide`, when
// a request has one chance. `client_id` is minted by the client for the same
// reason — a batch that is retried after a dropped connection must not count
// twice — and `ignoreDuplicates` is what makes the second copy a no-op.
onboarding.post("/onboarding/events", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const parsed = eventsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const rows = parsed.data.events.map((event) => ({
    user_id: user.id,
    client_id: event.clientId ?? crypto.randomUUID(),
    step: event.step,
    event: event.event,
    at: event.at,
    elapsed_ms: event.elapsedMs ?? null,
  }));

  const { error } = await db
    .from("onboarding_events")
    .upsert(rows, { onConflict: "user_id,client_id", ignoreDuplicates: true });

  if (error) {
    console.error("failed to record onboarding events", error);
    return c.json({ error: "failed to record events" }, 500);
  }

  return c.json({ accepted: rows.length });
});

const finishSchema = z.object({
  // The persona the frontend picked from its templates, as POST /agents takes
  // it. Empty means "none", which the agent's default persona covers.
  persona: z.string().trim().max(8000).optional(),
  model: z.enum(MODEL_IDS).optional(),
});

/**
 * The welcome email, sent once.
 *
 * Both ways out of the first run end here — the finish that makes an agent
 * and the skip that does not — and the stamp is what they share: a run that
 * was already stamped is a reload, not an arrival, and gets no second welcome.
 */
function welcomeOnce(c: Context<AppEnv>, wasCompleted: boolean): void {
  if (wasCompleted) return;
  const user = c.get("user");
  if (!user.email) return;
  notify(c, welcomeEmail({ email: user.email, appUrl: appUrlOf(c) }));
}

// POST /onboarding/finish — the last tap of the run.
//
// Makes the assistant the run named and the conversation it opens in, both in
// one function (0119) so that a reload or a double tap finds what the first
// call made rather than making it again. The route adds the two things the
// function cannot know: which workspace the caller is in, and whether the
// model they asked for is one this deployment serves.
onboarding.post("/onboarding/finish", async (c) => {
  // A first run is finished by the person it belongs to, in a browser. A key
  // that could do it would stamp an account as arrived, make its first agent
  // and send its welcome, none of which revoking the key takes back.
  const refusal = refuseIfKeyAuthenticated(c, "finish a first run");
  if (refusal) return c.json(refusal, 403);

  const db = c.get("db");

  const parsed = finishSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const { persona, model } = parsed.data;

  // An invited account that has not taken its invitation yet (0115) has
  // nowhere to put an agent. The frontend keeps it on the invitation.
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) {
    return c.json({ error: "no workspace found for user", code: "no_workspace" }, 404);
  }

  // A Claude id with no key behind it would be stored and silently ignored —
  // the same rule PATCH /workspace applies to the default.
  if (model && !availableModels(c.env).includes(model)) {
    return c.json({ error: `${model} is not configured on this deployment` }, 400);
  }

  const { data, error } = await db.rpc("finish_onboarding", {
    p_workspace_id: workspaceId,
    p_persona: persona || null,
    p_model: model ?? null,
  });

  if (error) {
    // The function's own refusal: no row, or a row with no assistant named.
    if (error.code === "P0002") {
      return c.json({ error: "name your assistant first", code: "incomplete" }, 400);
    }
    console.error("failed to finish onboarding", error);
    return c.json({ error: "failed to finish onboarding" }, 500);
  }

  // `returns table` comes back as a set, even of one.
  const row = (Array.isArray(data) ? data[0] : data) as
    { agent_id: string; session_id: string; created: boolean; was_completed: boolean } | undefined;
  if (!row?.agent_id || !row.session_id) {
    console.error("finish_onboarding returned no row");
    return c.json({ error: "failed to finish onboarding" }, 500);
  }

  welcomeOnce(c, row.was_completed);

  return c.json({
    completed: true,
    agentId: row.agent_id,
    sessionId: row.session_id,
    created: row.created,
  });
});

// POST /onboarding/complete — the first run is over, with no agent made.
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
  welcomeOnce(c, false);

  return c.json({ completed: true });
});

export { onboarding };
