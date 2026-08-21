import { Hono } from "hono";
import { z } from "zod";
import OpenAI from "openai";
import type { AppEnv } from "../types";
import { serviceClient } from "../lib/supabase";
import { getActiveWorkspaceId } from "../lib/workspace";
import { mapRoutine, mapRoutineRun, mapDeliveryChannel } from "../lib/dto";
import { parseDraft } from "../lib/routines/draft";
import { runOneRoutine } from "../lib/routines/dispatcher";
import type { RoutineRow } from "../lib/routines/executor";
import { isValidCron, nextRunAt } from "../lib/routines/schedule";
import { assertFetchableUrl, ownHostsFrom } from "../lib/routines/url-guard";
import { encryptSecret, maskSecret } from "../lib/routines/crypto";
import { insertErrorStatus } from "../lib/routines/insert-error";
import { DEFAULT_MODEL } from "../lib/models";
import { guardQuota, recordQuota } from "../lib/entitlements/guard";

const routines = new Hono<AppEnv>();

// ---- draft ---------------------------------------------------------------

const draftBodySchema = z.object({
  text: z.string().min(1),
  timezone: z.string().default("UTC"),
});

// POST /routines/draft — natural language in, an editable definition out.
// Nothing is persisted; the user confirms on screen before anything is saved.
// This is the only place in this file that touches an LLM: setup reasons once,
// every execution afterwards is deterministic.
routines.post("/routines/draft", async (c) => {
  const denied = await guardQuota(c);
  if (denied) return denied;

  const parsed = draftBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const client = new OpenAI({ apiKey: c.env.OPENAI_API_KEY });
  // parseDraft may call the model more than once. Totalled here and recorded
  // once, whether the draft parses or is rejected — a failed parse still spent.
  let spent = 0;
  const complete = async (prompt: string) => {
    const res = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });
    spent += res.usage?.total_tokens ?? 0;
    return res.choices[0]?.message?.content ?? "";
  };

  try {
    const draft = await parseDraft(parsed.data.text, {
      complete,
      timezone: parsed.data.timezone,
      ownHosts: ownHostsFrom(c.env),
    });
    return c.json(draft);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "could not read that" }, 422);
  } finally {
    await recordQuota(c, spent);
  }
});

// ---- delivery channels -----------------------------------------------------

const channelSchema = z.object({
  kind: z.enum(["slack_webhook", "email"]),
  secret: z.string().min(1),
});

// GET /delivery-channels — masked labels only; RLS scopes to the caller and the
// column grant means the secret is not selectable even by mistake.
routines.get("/delivery-channels", async (c) => {
  const { data, error } = await c
    .get("db")
    .from("delivery_channels")
    .select("id, kind, label, created_at")
    .order("created_at", { ascending: false });

  if (error) return c.json({ error: "failed to load channels" }, 500);
  return c.json((data ?? []).map(mapDeliveryChannel));
});

// POST /delivery-channels — the one write that needs the service role, because
// the secret must be encrypted before it is stored. The owner comes from the
// verified token, never from the body. The workspace is the caller's *active*
// workspace (profiles.active_workspace_id), not an arbitrary membership row —
// a user in several workspaces would otherwise get a channel filed under
// whichever workspace happened to sort first.
routines.post("/delivery-channels", async (c) => {
  const parsed = channelSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { kind, secret } = parsed.data;

  if (kind === "slack_webhook") {
    try {
      const url = assertFetchableUrl(secret, ownHostsFrom(c.env));
      if (url.host !== "hooks.slack.com") {
        return c.json({ error: "not a slack webhook url" }, 400);
      }
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "invalid url" }, 400);
    }
  } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(secret)) {
    return c.json({ error: "not an email address" }, 400);
  }

  const user = c.get("user");
  const workspaceId = await getActiveWorkspaceId(c.get("db"), user.id);
  if (!workspaceId) return c.json({ error: "no workspace" }, 400);

  const { data, error } = await serviceClient(c.env)
    .from("delivery_channels")
    .insert({
      workspace_id: workspaceId,
      user_id: user.id,
      kind,
      label: maskSecret(kind, secret),
      secret_ciphertext: await encryptSecret(secret, c.env.ROUTINE_SECRET_KEY),
    })
    .select("id, kind, label, created_at")
    .single();

  if (error) return c.json({ error: "failed to create channel" }, 500);
  return c.json(mapDeliveryChannel(data), 201);
});

routines.delete("/delivery-channels/:id", async (c) => {
  const { error } = await c
    .get("db")
    .from("delivery_channels")
    .delete()
    .eq("id", c.req.param("id"));

  if (error) {
    // 22P02 is Postgres's "invalid input syntax" — a malformed uuid in the
    // path, which is a bad request, not a conflict.
    if (error.code === "22P02") return c.json({ error: "invalid channel id" }, 400);
    // Otherwise this is routines.delivery_channel_id's FK: `no action deferrable
    // initially deferred` lets same-transaction cascades (workspace/user delete)
    // complete first, but a direct delete of a channel still wired to a routine
    // still fails the check when it's evaluated at end of statement/transaction —
    // surface that as a conflict.
    return c.json({ error: "channel is still in use" }, 409);
  }
  return c.body(null, 204);
});

// ---- routines --------------------------------------------------------------

const createSchema = z.object({
  agentId: z.string().uuid(),
  name: z.string().min(1),
  sourceKind: z.enum(["rss", "web", "none"]),
  sourceUrl: z.string().nullable().optional(),
  instruction: z.string().min(1),
  deliveryChannelId: z.string().uuid(),
  scheduleCron: z.string().min(1),
  timezone: z.string().default("UTC"),
});

// agentId and workspaceId are deliberately absent from updateSchema. The
// database is the real boundary — routines_update_own's WITH CHECK now carries
// the same workspace, agent and channel guards as the INSERT policy — but there
// is no reason for this endpoint to offer a re-target it has no use for.
const updateSchema = z
  .object({
    name: z.string().min(1).optional(),
    instruction: z.string().min(1).optional(),
    scheduleCron: z.string().min(1).optional(),
    timezone: z.string().optional(),
    status: z.enum(["active", "paused"]).optional(),
    visibility: z.enum(["private", "shared"]).optional(),
    deliveryChannelId: z.string().uuid().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "no fields to update" });

routines.get("/routines", async (c) => {
  const { data, error } = await c
    .get("db")
    .from("routines")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return c.json({ error: "failed to load routines" }, 500);
  return c.json((data ?? []).map(mapRoutine));
});

routines.post("/routines", async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const body = parsed.data;

  if (!isValidCron(body.scheduleCron, body.timezone)) {
    return c.json({ error: "unusable schedule" }, 400);
  }
  if (body.sourceKind !== "none") {
    if (!body.sourceUrl) return c.json({ error: "this source needs a url" }, 400);
    try {
      assertFetchableUrl(body.sourceUrl, ownHostsFrom(c.env));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "invalid url" }, 400);
    }
  }

  const db = c.get("db");
  const { data: agent } = await db
    .from("agents")
    .select("workspace_id")
    .eq("id", body.agentId)
    .single();
  if (!agent) return c.json({ error: "agent not found" }, 404);

  const { data, error } = await db
    .from("routines")
    .insert({
      workspace_id: agent.workspace_id,
      agent_id: body.agentId,
      user_id: c.get("user").id,
      name: body.name,
      source_kind: body.sourceKind,
      source_config: body.sourceUrl ? { url: body.sourceUrl } : {},
      instruction: body.instruction,
      delivery_channel_id: body.deliveryChannelId,
      schedule_cron: body.scheduleCron,
      timezone: body.timezone,
      next_run_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error) {
    const status = insertErrorStatus(error);
    if (status === 400) {
      return c.json(
        { error: "the delivery channel or agent is not available to you in this workspace" },
        400,
      );
    }
    return c.json({ error: "failed to create routine" }, 500);
  }
  return c.json(mapRoutine(data), 201);
});

routines.patch("/routines/:id", async (c) => {
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const body = parsed.data;

  const db = c.get("db");
  const { data: current, error: loadError } = await db
    .from("routines")
    .select("schedule_cron, timezone")
    .eq("id", c.req.param("id"))
    .maybeSingle();

  if (loadError) return c.json({ error: "failed to load routine" }, 500);
  if (!current) return c.json({ error: "routine not found" }, 404);

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) patch.name = body.name;
  if (body.instruction !== undefined) patch.instruction = body.instruction;
  if (body.visibility !== undefined) patch.visibility = body.visibility;
  if (body.deliveryChannelId !== undefined) patch.delivery_channel_id = body.deliveryChannelId;

  // Validate the pair that will actually be in effect, not just the field that
  // changed — a timezone the cron parser cannot resolve leaves the executor
  // unable to compute a next run at all, and a timezone-only patch that skips
  // validation writes an unvalidated string straight through: the routine
  // never fails loudly, it just stops advancing and re-claims every tick
  // without ever reaching the failure counter that would auto-pause it.
  const cron = body.scheduleCron ?? current.schedule_cron;
  const timezone = body.timezone ?? current.timezone;
  const scheduleChanged = body.scheduleCron !== undefined || body.timezone !== undefined;

  if (scheduleChanged) {
    if (!isValidCron(cron, timezone)) return c.json({ error: "unusable schedule" }, 400);
    patch.schedule_cron = cron;
    patch.timezone = timezone;
    patch.next_run_at = nextRunAt(cron, timezone, new Date()).toISOString();
  }

  // Resuming clears the failure state, otherwise one more error re-pauses it.
  // This comes after the schedule block so a resume's "fire promptly" wins
  // over a schedule change's computed next_run_at.
  if (body.status !== undefined) {
    patch.status = body.status;
    if (body.status === "active") {
      patch.paused_reason = null;
      patch.consecutive_failures = 0;
      patch.next_run_at = new Date().toISOString();
    }
  }

  const { data, error } = await db
    .from("routines")
    .update(patch)
    .eq("id", c.req.param("id"))
    .select("*")
    .maybeSingle();

  if (error) return c.json({ error: "failed to update routine" }, 500);
  if (!data) return c.json({ error: "routine not found" }, 404);
  return c.json(mapRoutine(data));
});

// POST /routines/:id/run — run it now instead of waiting for the schedule.
//
// The engine's cron trigger fires every five minutes, so without this the only
// way to find out whether a routine works is to create it and wait. That makes
// every mistake — a feed that 404s, a webhook that was revoked, an instruction
// that produces nothing useful — cost a five-minute round trip to discover.
//
// Overlapping with a cron tick is safe: the executor reserves delivery keys
// before it sends, so the second run of a pair delivers nothing.
routines.post("/routines/:id/run", async (c) => {
  const db = c.get("db");

  // The executor checks quota too, but it can only record the refusal as a
  // skipped run. Checking here turns "nothing happened" into a 402 the person
  // who pressed the button can read.
  const denied = await guardQuota(c);
  if (denied) return denied;
  // Read through the caller's own client first. RLS already limits this to
  // routines they can see; the ownership check then narrows it to their own,
  // because running a routine spends the owner's LLM budget and delivers to
  // the owner's channel — neither is a teammate's to trigger.
  const { data: routine, error } = await db
    .from("routines")
    .select("*")
    .eq("id", c.req.param("id"))
    .maybeSingle();

  if (error) return c.json({ error: "failed to load routine" }, 500);
  if (!routine) return c.json({ error: "routine not found" }, 404);
  if (routine.user_id !== c.get("user").id) {
    return c.json({ error: "only the owner can run this routine" }, 403);
  }

  // Email delivery goes through Resend, whose key is a secret on whichever
  // account this Worker runs on. Saying so beats a run that fails with a bare
  // 401 from an API the user has never heard of.
  if (!c.env.RESEND_API_KEY || !c.env.RESEND_FROM) {
    const { data: channel } = await db
      .from("delivery_channels")
      .select("kind")
      .eq("id", routine.delivery_channel_id)
      .maybeSingle();
    if (channel?.kind === "email") {
      return c.json({ error: "email delivery is not configured on this worker" }, 503);
    }
  }

  const result = await runOneRoutine(c.env, routine as RoutineRow);
  return c.json(result);
});

routines.delete("/routines/:id", async (c) => {
  const { error } = await c.get("db").from("routines").delete().eq("id", c.req.param("id"));
  if (error) return c.json({ error: "failed to delete routine" }, 500);
  return c.body(null, 204);
});

// GET /routines/:id/runs — history. A 'skipped' row is the answer to "why
// didn't it send me anything?", so it is shown, not hidden.
routines.get("/routines/:id/runs", async (c) => {
  const { data, error } = await c
    .get("db")
    .from("routine_runs")
    .select("*")
    .eq("routine_id", c.req.param("id"))
    .order("started_at", { ascending: false })
    .limit(50);

  if (error) return c.json({ error: "failed to load runs" }, 500);
  return c.json((data ?? []).map(mapRoutineRun));
});

export { routines };
