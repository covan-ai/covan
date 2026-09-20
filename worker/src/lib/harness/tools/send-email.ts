import { deliver, deliveryDepsFrom, type DeliveryChannel } from "../../routines/delivery";
import { deliveryChannelSecret } from "../secrets";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";

/**
 * Send a message to a channel this person already owns.
 *
 * **The model never names an address.** It names a channel id, and the channel
 * has to be one whose `user_id` is the person the turn is running for. So the
 * worst an injected instruction can achieve is a message the person receives
 * themselves — the same ceiling `summarise.ts` describes for a routine, kept
 * rather than widened now that the agent can act.
 *
 * `deliver()` is reused whole, so this sends through the same code and the
 * same guards as a routine: the webhook signature, the SSRF check at send
 * time, the email shell. "Slack" and "webhook" channels work here for free,
 * which is why the tool is `send_message` in everything but its name — the
 * name stays `send_email` because that is what a person asks for.
 */
export const sendEmailTool: AgentTool = {
  name: "send_email",
  description:
    "Send a message to one of this person's own delivery channels — their email, their " +
    "Slack webhook. You cannot send to an address: you name a channel the person already " +
    "set up. Use it when you are asked to send, email or report something now; for " +
    "something that should happen on a schedule, use schedule_job instead.",
  input: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "The id of one of this person's channels." },
      subject: { type: "string", description: "One line. Becomes the email subject." },
      body: { type: "string", description: "The message, in Markdown." },
    },
    required: ["channelId", "subject", "body"],
    additionalProperties: false,
  },
  destructive: true,
  needs: "channel",
  isConfigured: (env: ToolEnv) =>
    Boolean(env.RESEND_API_KEY && env.RESEND_FROM && env.ROUTINE_SECRET_KEY),
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = args as { channelId?: unknown; subject?: unknown; body?: unknown };
    if (typeof input.channelId !== "string" || !input.channelId) {
      return { kind: "error", message: "channelId is required" };
    }
    if (typeof input.subject !== "string" || !input.subject.trim()) {
      return { kind: "error", message: "subject is required" };
    }
    if (typeof input.body !== "string" || !input.body.trim()) {
      return { kind: "error", message: "body is required" };
    }

    // Through the caller's own client, and filtered by `user_id` as well:
    // `delivery_channels_select_own` already scopes it, and the explicit
    // filter is the same belt `lib/routines/executor.ts` wears for the same
    // reason — the id came from the model.
    const { data: visible, error } = await ctx.db
      .from("delivery_channels")
      .select("id, kind, label")
      .eq("id", input.channelId)
      .eq("user_id", ctx.userId)
      .maybeSingle();
    if (error) return { kind: "error", message: `could not load that channel: ${error.message}` };
    if (!visible) return { kind: "error", message: "no such channel belongs to this person" };

    if (ctx.confirmed !== true) {
      return {
        kind: "needs_confirmation",
        summary: `Send "${input.subject.trim()}" to ${String(visible.label ?? visible.kind)}?`,
        proposal: {
          kind: "send_email",
          channel: { id: visible.id, label: visible.label, kind: visible.kind },
          subject: input.subject.trim(),
          body: input.body,
        },
      };
    }

    // The ciphertext, after the question of permission has been answered by
    // the read above. Same order as `lib/harness/secrets.ts` says: ask, then
    // fetch.
    const secret = await deliveryChannelSecret(ctx.env, { id: String(visible.id) });
    if (!secret) return { kind: "error", message: "that channel has no stored destination" };

    await deliver(
      secret as unknown as DeliveryChannel,
      { subject: input.subject.trim(), body: input.body },
      deliveryDepsFrom(ctx.env),
      { event: "agent.sent" },
    );

    return { kind: "ok", content: `Sent to ${String(visible.label ?? visible.kind)}.` };
  },
};
