import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv, Bindings } from "../types";
import { serviceClient } from "../lib/supabase";
import { callerWorkspaceId } from "../lib/workspace";
import { deferred } from "../lib/defer";
import { encryptSecret } from "../lib/secret-box";
import {
  nonceHashOf,
  openGrant,
  readState,
  sealGrant,
  signState,
} from "../lib/connections/oauth-state";
import { entitlementsFor } from "../lib/entitlements";
import { verifySlackSignature } from "../lib/slack/verify";
import { exchangeSlackCode } from "../lib/slack/api";
import { handleSlackEvent, type InstallationRow, type SlackEvent } from "../lib/slack/handle";
import { refuseIfKeyAuthenticated } from "../lib/api-key-rule";
import { readCapped } from "../lib/routines/source";
import { getRateLimiter } from "../lib/ratelimit";
import { countMiss, hasSpentMisses, refuseSpent } from "../middleware/ratelimit";

/**
 * Slack: installing the app, and receiving what it hears.
 *
 * Two of these routes are public and they are public for different reasons. The
 * install callback carries a browser back from Slack's consent screen with no
 * session — the same problem `connections` has, solved the same way. The events
 * endpoint is called by Slack itself, which has no Covan account at all and
 * never will: what stands in for authentication there is the signature, and
 * `lib/slack/verify.ts` is the whole of that argument.
 */

const slack = new Hono<AppEnv>();

/** Unauthenticated by necessity — mounted on the root app, not on `api`. */
const slackPublic = new Hono<AppEnv>();

/**
 * What the app asks Slack for.
 *
 * `users:read.email` is the one worth defending, because it looks like more
 * than it is: without it the app cannot tell who is asking, and 0044 explains
 * why answering as the installer instead is the end of tenancy. The rest is the
 * minimum to hear a mention, hear a DM, and reply.
 */
// `channels:read` tells a public channel from a private one, which decides
// who in Covan can see the conversation a mention starts (`isPublicChannel`).
const SCOPES = [
  "app_mentions:read",
  "channels:read",
  "chat:write",
  "im:history",
  "users:read",
  "users:read.email",
];

function slackConfigured(env: Bindings): boolean {
  return Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.SLACK_SIGNING_SECRET);
}

function apiOrigin(c: { env: Bindings; req: { url: string } }): string {
  return c.env.WORKER_HOST
    ? `https://${c.env.WORKER_HOST.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`
    : new URL(c.req.url).origin;
}

function frontendOrigin(env: Bindings): string {
  return env.ALLOWED_ORIGIN.split(",")[0].trim().replace(/\/+$/, "");
}

const INSTALLATION_SELECT =
  "id,workspace_id,team_id,team_name,bot_user_id,agent_id,installed_by,created_at";

/**
 * Every route below scopes to the caller's *active* workspace, and none of them
 * could get away with letting RLS do it alone.
 *
 * A person can be an admin of two workspaces, and 0044's policies are written
 * from the workspace's point of view — so an unscoped read returns both
 * installations, an unscoped update changes both, and an unscoped delete
 * disconnects a Slack the caller was not looking at. The policy is still the
 * thing that says *whether* they may; this says *which*.
 */
async function activeInstallationId(c: Context<AppEnv>): Promise<string | null> {
  const db = c.get("db");
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return null;

  const { data } = await db
    .from("slack_installations")
    .select("id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  return (data?.id as string) ?? null;
}

// GET /slack — whether Slack is available here, and what is installed.
slack.get("/slack", async (c) => {
  const db = c.get("db");
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace" }, 400);

  const { data, error } = await db
    .from("slack_installations")
    .select(INSTALLATION_SELECT)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) return c.json({ error: "failed to load the Slack installation" }, 500);

  return c.json({
    configured: slackConfigured(c.env),
    installation: data
      ? {
          id: data.id,
          teamName: data.team_name,
          agentId: data.agent_id,
          installedBy: data.installed_by,
          createdAt: Date.parse(data.created_at as string),
        }
      : null,
  });
});

// POST /slack/install/start — begin the install.
slack.post("/slack/install/start", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "install Slack");
  if (refusal) return c.json(refusal, 403);

  if (!slackConfigured(c.env)) {
    return c.json({ error: "Slack is not configured on this deployment" }, 501);
  }

  // The hash of the nonce this tab keeps for the flow; `/slack/complete` asks
  // for the nonce itself. See `lib/connections/oauth-state.ts`.
  const parsed = installSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const user = c.get("user");
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace" }, 400);

  const state = await signState(
    { provider: "slack", userId: user.id, workspaceId, nonceHash: parsed.data.nonceHash },
    c.env.ROUTINE_SECRET_KEY,
  );

  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", c.env.SLACK_CLIENT_ID ?? "");
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("redirect_uri", `${apiOrigin(c)}/slack/callback`);
  url.searchParams.set("state", state);

  return c.json({ url: url.toString() });
});

const installSchema = z.object({
  nonceHash: z.string().regex(/^[0-9a-f]{64}$/, "a flow nonce's hash is required"),
});

const patchSchema = z.object({ agentId: z.string().min(1) });

// PATCH /slack/installation — choose which agent answers.
slack.patch("/slack/installation", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "change the Slack installation");
  if (refusal) return c.json(refusal, 403);

  const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const id = await activeInstallationId(c);
  if (!id) return c.json({ error: "not found" }, 404);

  // Through the caller's own client: the policy decides whether they are the
  // installer or an admin, and its WITH CHECK is what stops the agent being
  // pointed at another workspace's. `agent_id` is the only column 0044 grants —
  // `updated_at` is not one, and setting it here would fail the whole statement
  // with a permission error rather than a refusal anybody could read.
  const { data, error } = await c
    .get("db")
    .from("slack_installations")
    .update({ agent_id: parsed.data.agentId })
    .eq("id", id)
    .select("id,agent_id")
    .maybeSingle();
  if (error) return c.json({ error: "failed to update the Slack installation" }, 500);
  if (!data) return c.json({ error: "you do not have permission to change this" }, 403);

  return c.json({ id: data.id, agentId: data.agent_id });
});

// DELETE /slack/installation — disconnect.
//
// Only the row goes. Slack's own side of an install is revoked from Slack, and
// pretending otherwise — by calling `auth.revoke` here — would leave the two
// disagreeing whenever that call failed. The conversations stay: they are
// ordinary sessions, and 0044 lets `slack_threads` cascade rather than taking
// them with it.
slack.delete("/slack/installation", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "remove the Slack installation");
  if (refusal) return c.json(refusal, 403);

  const id = await activeInstallationId(c);
  if (!id) return c.json({ error: "not found" }, 404);

  const { data, error } = await c
    .get("db")
    .from("slack_installations")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) return c.json({ error: "failed to disconnect Slack" }, 500);
  if (!data || data.length === 0) {
    return c.json({ error: "you do not have permission to disconnect this" }, 403);
  }
  return c.json({ ok: true });
});

/**
 * GET /slack/callback — where Slack sends the browser back after an install.
 *
 * It decides nothing, for the reason `GET /connections/callback` gives: the
 * browser carries no Covan session, and trusting the state alone let somebody
 * start an install and send the consent link to another team's admin, whose
 * Slack then answered to the starter's workspace (and, being taken, locked the
 * team's own workspace out). The code is sealed into a grant and the app
 * completes it with `POST /slack/complete`, as the person who started it.
 */
slackPublic.get("/slack/callback", async (c) => {
  const home = `${frontendOrigin(c.env)}/integrations`;
  const fail = (reason: string) => c.redirect(`${home}?error=${encodeURIComponent(reason)}`, 302);

  const url = new URL(c.req.url);
  if (url.searchParams.get("error")) return fail("cancelled");
  if (!slackConfigured(c.env)) return fail("unavailable");

  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state");
  if (!code || !rawState) return fail("missing_code");

  const state = await readState(rawState, c.env.ROUTINE_SECRET_KEY);
  if (!state || state.provider !== "slack") return fail("expired");

  const grant = await sealGrant(
    { state, code, redirectUri: `${apiOrigin(c)}/slack/callback` },
    c.env.ROUTINE_SECRET_KEY,
  );
  return c.redirect(`${home}?grant=${grant}&for=slack`, 302);
});

const completeSchema = z.object({
  grant: z.string().min(1).max(16_384),
  nonce: z.string().min(16).max(200),
});

/**
 * POST /slack/complete — finish an install, as the admin who started it.
 *
 * What the callback used to do, behind the two checks it could not make: the
 * caller is the state's person and holds the flow's nonce. Then, as before,
 * they must still be an admin there, and a team already answering another
 * workspace is not taken over.
 */
slack.post("/slack/complete", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "install Slack");
  if (refusal) return c.json(refusal, 403);

  if (!slackConfigured(c.env)) return c.json({ error: "unavailable" }, 501);

  const parsed = completeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "missing_code" }, 400);

  const grant = await openGrant(parsed.data.grant, c.env.ROUTINE_SECRET_KEY);
  if (!grant || grant.state.provider !== "slack") return c.json({ error: "expired" }, 400);
  const { state, code } = grant;

  if (state.userId !== c.get("user").id) return c.json({ error: "not_yours" }, 403);
  if ((await nonceHashOf(parsed.data.nonce)) !== state.nonceHash) {
    return c.json({ error: "not_yours" }, 403);
  }

  const admin = serviceClient(c.env);

  const { data: membership } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", state.workspaceId)
    .eq("user_id", state.userId)
    .maybeSingle();
  if (!membership) return c.json({ error: "not_a_member" }, 403);
  if (membership.role !== "admin") return c.json({ error: "admin_only" }, 403);

  let install;
  try {
    install = await exchangeSlackCode(fetch.bind(globalThis), c.env, code, grant.redirectUri);
  } catch (err) {
    console.error("slack install failed", err);
    return c.json({ error: "exchange_failed" }, 502);
  }

  // One Slack team answers one Covan workspace. Moving it is uninstall and
  // reinstall from the workspace that holds it, never a second install here.
  const { data: holder } = await admin
    .from("slack_installations")
    .select("workspace_id")
    .eq("team_id", install.teamId)
    .maybeSingle();
  if (holder && holder.workspace_id !== state.workspaceId) {
    return c.json({ error: "team_taken" }, 409);
  }

  // Which agent answers, before anybody has been asked. The oldest one is the
  // workspace's first and usually its main; the alternative is an app that is
  // installed and refuses every question until somebody visits a settings page
  // they have not been told about.
  //
  // The oldest one shared with the whole workspace, when there is one (0104).
  // Slack answers only the people who can use the agent, and an agent shared
  // with nobody would turn the install into a bot that refuses the channel.
  const oldestAgent = (sharedOnly: boolean) => {
    let query = admin
      .from("agents")
      .select("id")
      .eq("workspace_id", state.workspaceId)
      .is("deleted_at", null);
    if (sharedOnly) query = query.not("workspace_access", "is", null);
    return query.order("created_at", { ascending: true }).limit(1).maybeSingle();
  };
  const { data: shared } = await oldestAgent(true);
  const agent = shared ?? (await oldestAgent(false)).data;

  const { error } = await admin.from("slack_installations").upsert(
    {
      workspace_id: state.workspaceId,
      team_id: install.teamId,
      team_name: install.teamName,
      bot_user_id: install.botUserId,
      secret_ciphertext: await encryptSecret(install.botToken, c.env.ROUTINE_SECRET_KEY),
      agent_id: agent?.id ?? null,
      installed_by: state.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "team_id" },
  );
  if (error) {
    console.error("failed to save the slack installation", error);
    return c.json({ error: "save_failed" }, 500);
  }

  return c.json({ provider: "slack" });
});

/** Slack event payloads are kilobytes. Anything near this is not Slack. */
const SLACK_EVENT_MAX_BYTES = 1024 * 1024;

/**
 * POST /slack/events — everything the app hears.
 *
 * Slack gives an app three seconds to acknowledge and retries when it does not,
 * so this route answers 200 first and does the work in `deferred`. That is not
 * an optimisation: a reply takes a model call, and every one of those would be
 * a retry — and a retry that arrives while the first is still running is a
 * second answer in the thread.
 */
slackPublic.post("/slack/events", async (c) => {
  // An address that keeps failing the signature is refused before its next
  // body is read. Slack's own deliveries always verify and so never count.
  if (hasSpentMisses(c)) return refuseSpent(c);

  // The raw body, byte for byte. Re-serialising the parsed JSON produces a
  // different string and the signature is over what Slack sent.
  //
  // Capped while it streams in, and before the signature is checked, because
  // the check needs the whole body and the caller is not anybody yet. Read
  // whole, this was an unauthenticated way to make the Node entry hold
  // hundreds of megabytes. Slack's events are a few kilobytes; a megabyte is
  // generous.
  let body: string;
  try {
    body = await readCapped(c.req.raw, SLACK_EVENT_MAX_BYTES);
  } catch {
    return c.json({ error: "payload too large" }, 413);
  }

  const verified = await verifySlackSignature(
    c.env.SLACK_SIGNING_SECRET ?? "",
    {
      signature: c.req.header("x-slack-signature"),
      timestamp: c.req.header("x-slack-request-timestamp"),
    },
    body,
  );
  if (!verified.ok) {
    console.warn("slack event rejected:", verified.reason);
    await countMiss(c);
    return c.json({ error: "unauthorized" }, 401);
  }

  const payload = JSON.parse(body) as {
    type?: string;
    challenge?: string;
    team_id?: string;
    event?: SlackEvent;
  };

  // The handshake Slack does when the URL is first entered. It arrives signed,
  // so it is checked above like anything else.
  if (payload.type === "url_verification") {
    return c.json({ challenge: payload.challenge });
  }

  if (payload.type !== "event_callback" || !payload.event || !payload.team_id) {
    return c.json({ ok: true });
  }

  // A retry means our acknowledgement did not arrive, not that the work did not
  // happen — the 200 below is sent before any of it starts. Answering again
  // would post a second reply into a thread that may already have one, so the
  // retry is dropped and said out loud. If these ever appear in the logs in
  // numbers, the acknowledgement is too slow rather than the retry wrong.
  const retry = c.req.header("x-slack-retry-num");
  if (retry) {
    console.warn("slack retry dropped", { retry, reason: c.req.header("x-slack-retry-reason") });
    return c.json({ ok: true });
  }

  const event = payload.event;
  const teamId = payload.team_id;

  // Counted per Slack team, which the signature has just vouched for. Slack
  // delivers every team's events from the same few addresses, so this route
  // is in front of the per-address limit, and the team is the thing whose
  // volume is ours to bound. Over it, the event is acknowledged and dropped:
  // Slack treats a 429 as a failed delivery, retries it (which is dropped
  // above anyway), and switches off an app whose deliveries keep failing.
  const teamVerdict = await getRateLimiter(c.env, "standard").check(`slack-team:${teamId}`);
  if (!teamVerdict.allowed) {
    console.warn("slack event dropped: team over its rate", teamId);
    return c.json({ ok: true });
  }

  deferred(
    c,
    (async () => {
      const admin = serviceClient(c.env);
      const { data: installation, error } = await admin
        .from("slack_installations")
        .select("id,workspace_id,team_id,bot_user_id,secret_ciphertext,agent_id")
        .eq("team_id", teamId)
        .maybeSingle();
      if (error || !installation) {
        // A Slack workspace we have no row for. Silent on purpose: it is either
        // an install that was removed here and not there, or somebody pointing
        // their own Slack app at this URL, and neither deserves a message
        // posted into a stranger's channel.
        console.warn("slack event for an unknown team", teamId);
        return;
      }

      await handleSlackEvent(installation as InstallationRow, event, {
        db: admin,
        env: c.env,
        entitlements: entitlementsFor(c.env),
        fetchImpl: fetch.bind(globalThis),
      });
    })(),
  );

  return c.json({ ok: true });
});

export { slack, slackPublic };
