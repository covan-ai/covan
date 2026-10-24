import { GUIDE_TOPICS, guideFor } from "../../covan-guide-text";
import type { AgentTool, ToolResult } from "../registry";

/**
 * What Covan is and how to use it, for an agent asked about the product it
 * runs in.
 *
 * The system prefix says in one paragraph what Covan is (`ABOUT_COVAN` in
 * `lib/prompt.ts`) and sends questions about it here. The guide itself is in
 * `lib/covan-guide-text.ts`: product knowledge the person never sees as such,
 * only in the agent's answer, and paid for on the turns that ask rather than
 * on every turn.
 *
 * Reads nothing and changes nothing, so it needs no context, no connection and
 * no approval, and is offered on every deployment.
 */
export const covanGuideTool: AgentTool = {
  name: "covan_guide",
  description:
    "Look up how Covan works — the product you are running in. Call it when someone asks what " +
    "Covan is, what they can do with it, how to do something in it (add documents, connect an " +
    "app, set up a routine, invite people, share an agent or a thread, write a report, get an " +
    "API key, see credits), or where something is in the app. Pick the closest topic; call it " +
    "again for another. Answer from what it returns rather than from memory, in the person's " +
    "language and in their terms, naming where in the app to go (sidebar pages, an agent's tabs, " +
    "Settings pages). Give what their question needs — do not paste the whole guide back.",
  input: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        enum: [...GUIDE_TOPICS],
        description:
          "overview: what Covan is and what it can do. getting_started: first steps. agents: " +
          "making, configuring and sharing an agent. chat: threads, attachments, approvals, " +
          "brainstorm. knowledge: folders, uploads, synced sources, how answers use them. " +
          "documents: reports the agent writes, and reading or editing existing documents. " +
          "routines: scheduled and triggered runs and where results go. integrations: connected " +
          "apps, Drive, Notion, Slack, databases, the browser. team: invitations, roles, " +
          "sharing. settings_and_billing: settings pages, credits, export, account. api: API " +
          "keys and webhooks.",
      },
    },
    required: ["topic"],
  },
  destructive: false,
  isConfigured: () => true,
  async run(args: unknown): Promise<ToolResult> {
    const topic = (args as { topic?: unknown } | null)?.topic;
    return { kind: "ok", content: guideFor(topic) };
  },
};
