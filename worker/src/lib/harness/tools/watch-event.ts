import { createRoutine } from "../../routines/create";
import { ownHostsFrom } from "../../routines/url-guard";
import { EVENT_REGISTRY, canListenFor } from "../../routines/events/adapter";
import { EVENT_TYPES, parseEventChoice } from "../../routines/events/catalog";
import { replaceSubscription } from "../../routines/events/lifecycle";
import { checkRequirement } from "../../routines/events/requirements";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";

/**
 * Turn "tell me whenever a customer emails about an invoice" into a routine
 * that waits for that event — with a person's yes in the middle.
 *
 * `schedule_job`'s twin, and deliberately built the same way: no new kind of
 * object, an ordinary `routines` row (`trigger_kind = 'event'`, no source)
 * that shows up on the Routines screen and can be changed or stopped there;
 * `needs_confirmation` first, and only on the person's yes the insert, which
 * is `lib/routines/create.ts` through the caller's own client, followed by
 * the subscription, which is `replaceSubscription` — the two calls
 * `POST /routines` makes for the dialog, in the same order and with the same
 * checks: the catalogue's schema, whether this deployment can listen for it,
 * and whether what it needs is connected, asked through the caller's client.
 *
 * **Never an event that needs a pasted credential.** A Telegram routine wants
 * the bot's token, and a token is something a person pastes into the app,
 * not something a model should ever be handed or repeat. Those are refused
 * with a sentence pointing at the Routines page.
 */

/** Never read for an event routine (`claim_due_routines` skips them), but the column is required. */
const EVENT_ROUTINE_CRON = "0 * * * *";

/** The events a model may propose, as the description lists them. */
const OFFERED = EVENT_TYPES.filter((def) => !def.secret);

function catalogueLines(): string {
  return OFFERED.map((def) => {
    const fields = def.fields.map((f) => `${f.key}${f.optional ? "?" : ""}`).join(", ");
    return `- ${def.id}: ${def.app} · ${def.label}${fields ? ` (config: ${fields})` : ""}`;
  }).join("\n");
}

export const watchEventTool: AgentTool = {
  name: "watch_event",
  description:
    "Propose a routine that runs whenever something happens in an app — a new email, a " +
    "calendar event about to start, a GitHub push. The person is shown the proposal and has " +
    "to approve it before anything is created. Write `instruction` exactly as you would want " +
    "to read it each time the event arrives: you will be given a short account of the event, " +
    "but not this conversation. Events, with the config keys each takes (? = optional):\n" +
    catalogueLines(),
  input: {
    type: "object",
    properties: {
      name: { type: "string", description: "A short name for the routine, shown in a list." },
      instruction: {
        type: "string",
        description: "What to do each time the event arrives, written to be read cold.",
      },
      event: { type: "string", description: "The event's id from the list above." },
      config: {
        type: "object",
        description: "The event's filters, by the keys listed for it. Omit for none.",
      },
      channelId: {
        type: "string",
        description: "Which of this person's delivery channels the result goes to.",
      },
    },
    required: ["name", "instruction", "event", "channelId"],
    additionalProperties: false,
  },
  destructive: true,
  needs: "channel",
  isConfigured: (env: ToolEnv) => OFFERED.some((def) => canListenFor(EVENT_REGISTRY, env, def)),
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = args as {
      name?: unknown;
      instruction?: unknown;
      event?: unknown;
      config?: unknown;
      channelId?: unknown;
    };
    if (typeof input.name !== "string" || !input.name.trim()) {
      return { kind: "error", message: "name is required" };
    }
    if (typeof input.instruction !== "string" || !input.instruction.trim()) {
      return { kind: "error", message: "instruction is required" };
    }
    if (typeof input.event !== "string" || !input.event) {
      return { kind: "error", message: "event is required" };
    }
    if (typeof input.channelId !== "string" || !input.channelId) {
      return { kind: "error", message: "channelId is required" };
    }

    // Every check before a person is asked, not after they say yes — the
    // reasoning `schedule_job` gives for its cron.
    const def = EVENT_REGISTRY.eventType(input.event);
    if (def?.secret) {
      return {
        kind: "error",
        message:
          `${def.app} needs a credential pasted into the app, which you must not handle. ` +
          "Ask the person to set this routine up on the Routines screen.",
      };
    }
    const parsed = parseEventChoice(EVENT_REGISTRY, input.event, input.config ?? {});
    if (!parsed.ok) return { kind: "error", message: parsed.error };
    const choice = parsed.choice;
    if (!canListenFor(EVENT_REGISTRY, ctx.env, choice.def)) {
      return { kind: "error", message: "this deployment cannot listen for that event" };
    }
    const requirement = await checkRequirement(
      ctx.db,
      ctx.workspaceId,
      choice.def.requires,
      choice.def.app,
    );
    if (!requirement.ok) return { kind: "error", message: requirement.error };

    const { data: channel, error } = await ctx.db
      .from("delivery_channels")
      .select("id, kind, label")
      .eq("id", input.channelId)
      .eq("user_id", ctx.userId)
      .maybeSingle();
    if (error) return { kind: "error", message: `could not load that channel: ${error.message}` };
    if (!channel) return { kind: "error", message: "no such channel belongs to this person" };

    const what = `${choice.def.app} · ${choice.def.label}`;
    const proposal = {
      kind: "watch_event",
      name: input.name.trim(),
      instruction: input.instruction.trim(),
      event: {
        type: choice.def.id,
        app: choice.def.app,
        label: choice.def.label,
        config: choice.config,
      },
      channel: { id: channel.id, label: channel.label, kind: channel.kind },
    };

    if (ctx.confirmed !== true) {
      return {
        kind: "needs_confirmation",
        summary:
          `Create a routine "${proposal.name}" that runs on ${what}, delivering to ` +
          `${String(channel.label ?? channel.kind)}?`,
        proposal,
      };
    }

    const created = await createRoutine(
      ctx.db,
      {
        agentId: ctx.agentId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        name: proposal.name,
        sourceKind: "none",
        instruction: proposal.instruction,
        deliveryChannelId: String(channel.id),
        scheduleCron: EVENT_ROUTINE_CRON,
        timezone: "UTC",
        triggerKind: "event",
      },
      ownHostsFrom(ctx.env),
    );
    if (!created.ok) return { kind: "error", message: created.message };

    const config = requirement.connectionId
      ? { ...choice.config, connectionId: requirement.connectionId }
      : choice.config;
    let listening: Awaited<ReturnType<typeof replaceSubscription>>;
    try {
      listening = await replaceSubscription(ctx.env, created.row.id as string, {
        def: choice.def,
        config,
      });
    } catch (err) {
      // A routine waiting for an event nobody recorded would wait forever and
      // say it was fine — `POST /routines` removes it for the same reason.
      console.error("watch_event could not record the subscription", err);
      await ctx.db.from("routines").delete().eq("id", created.row.id);
      return { kind: "error", message: "could not set up that event; nothing was created" };
    }

    const setup =
      choice.def.provider === "github"
        ? " GitHub sends nothing until its webhook is added: the routine's page shows the URL and secret to paste into the repository's settings."
        : "";
    const state =
      listening.status === "active"
        ? `It is listening for ${what}.`
        : `It is saved, but not listening yet: ${listening.detail ?? "the app has not confirmed it"}.`;
    return {
      kind: "ok",
      content:
        `Created the routine "${proposal.name}". ${state}${setup} It can be changed or ` +
        "stopped on the Routines screen.",
    };
  },
};
