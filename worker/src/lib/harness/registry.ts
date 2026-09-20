import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import type { RetrievalConfig } from "../retrieval";
import type { ToolSpec } from "../completion";
import { searchDocumentsTool } from "./tools/search-documents";
import { describeConnectionTool } from "./tools/describe-connection";
import { queryDatabaseTool } from "./tools/query-database";
import { httpRequestTool } from "./tools/http-request";
import { sendEmailTool } from "./tools/send-email";
import { scheduleJobTool } from "./tools/schedule-job";

/**
 * Every tool an agent can be given, in one list.
 *
 * Copied in shape from `lib/connections/registry.ts`, down to the reason: one
 * list means adding a tool is one entry rather than a search for the four
 * places that enumerate them, and an unconfigured tool is reported as
 * unconfigured rather than hidden — a self-hoster reading the docs for a
 * feature their own build appears not to have is the failure that pattern
 * exists to avoid.
 *
 * What is deliberately NOT here is anything named after a service. There is no
 * `hubspot_contacts` and there will not be one: a service is a row in
 * `tool_connections` (0059), and `http_request` below is how every one of them
 * is reached. A tool of its own gets written the day the general road is
 * genuinely not enough, and then it is one entry in this list.
 */

/**
 * What a tool needs from the environment.
 *
 * `RoutineEnv` rather than `Bindings`, for the reason that type exists: the
 * harness has to run under the cron Worker as well as the API one, and a cron
 * Worker has no anon key and frequently no document store. `RetrievalConfig`
 * is the embedding half, which `search_documents` needs and every other tool
 * ignores.
 */
export type ToolEnv = RoutineEnv & RetrievalConfig;

/**
 * What a tool is told about who is asking.
 *
 * **Every id here is resolved, never passed in by the model.** That is the
 * same rule `lib/routines/executor.ts` holds itself to, and it is the whole
 * security posture of this file: the model chooses which tool to call and what
 * to put in its arguments, and it cannot choose whose workspace it runs in.
 * A tool that took a workspace id as an argument would be one hallucinated
 * uuid away from a cross-tenant read.
 */
export type ToolContext = {
  /**
   * The caller's own client, carrying their JWT — so every read and write a
   * tool makes is decided by the same RLS policies that decide for the screen
   * they are looking at.
   *
   * Not the service-role client, and the exception is worth naming: a secret
   * a tool has to decrypt is read by `lib/harness/connections.ts`, which asks
   * this client for permission first and only then reaches past it for the
   * ciphertext. That is the `withSecret` pattern from `routes/connections.ts`,
   * not a second one.
   */
  db: SupabaseClient;
  env: ToolEnv;
  workspaceId: string;
  agentId: string;
  userId: string;
  /** The chat session this turn belongs to, when a person is driving it. */
  sessionId?: string;
  /** The routine run this turn belongs to, when nobody is. */
  routineRunId?: string;
  /**
   * Whether a person has already said yes to this exact call.
   *
   * False on the first attempt, so a tool that wants confirmation asks for it.
   * True when the turn is resuming from `POST /chat/confirm/:id`, which is the
   * only thing that sets it — and it is set by the route from the stored
   * paused turn, never from anything the model wrote.
   */
  confirmed?: boolean;
  /** Bounds a tool's own outbound work. See `lib/harness/budget.ts`. */
  signal?: AbortSignal;
};

export type ToolResult =
  | { kind: "ok"; content: string }
  | { kind: "error"; message: string }
  /**
   * The tool has worked out what it would do and wants a person to say yes
   * first.
   *
   * Generic on purpose, and not because a second tool might want it one day —
   * because the mechanism `0058` needs for `ask → pending → approved` is
   * exactly this one, and bolting it on afterwards would mean going through
   * every tool a second time. `summary` is one sentence a person reads;
   * `proposal` is the machine-readable thing they are agreeing to, rendered by
   * the confirmation card and stored verbatim in `paused_turns`.
   */
  | { kind: "needs_confirmation"; summary: string; proposal: unknown };

export type AgentTool = {
  name: string;
  description: string;
  /** JSON Schema for the arguments. Sent to the provider as-is. */
  input: Record<string, unknown>;
  /**
   * Whether this tool changes something outside Covan.
   *
   * 0058 spells the same idea `connection_capabilities.is_destructive`, and
   * this is deliberately the same word: the day a capability catalogue row
   * exists for one of these, this field is what it is populated from. Until
   * then it decides one thing — a destructive tool is named in the step line
   * with what it did, never folded into a count.
   */
  destructive: boolean;
  /**
   * Whether this deployment can offer the tool at all.
   *
   * A tool that says no is not hidden from the operator; it is left out of the
   * list the model is given, because a tool the model can call and this build
   * cannot run is worse than one that does not exist. `toolAvailability`
   * reports both states for the interface.
   */
  isConfigured(env: ToolEnv): boolean;
  /**
   * What this workspace must already have for the tool to be worth offering.
   *
   * Not a permission — `isConfigured` is about the deployment and RLS is
   * about the caller; this is about whether the tool has anything to point
   * at. A workspace with no connected services gets no `query_database` in
   * its prompt, which saves the tokens and, more usefully, removes the
   * invitation to invent a connection id. See `lib/harness/available.ts`.
   */
  needs?: "connection" | "channel";
  run(args: unknown, ctx: ToolContext): Promise<ToolResult>;
};

/** Every tool, configured or not, in the order the interface lists them. */
export const TOOLS: AgentTool[] = [
  searchDocumentsTool,
  describeConnectionTool,
  queryDatabaseTool,
  httpRequestTool,
  sendEmailTool,
  scheduleJobTool,
];

export function toolByName(name: string): AgentTool | null {
  return TOOLS.find((t) => t.name === name) ?? null;
}

/** The tools this deployment can actually run. */
export function configuredTools(env: ToolEnv): AgentTool[] {
  return TOOLS.filter((t) => t.isConfigured(env));
}

/** What the interface shows: every tool, and whether this build can run it. */
export function toolAvailability(
  env: ToolEnv,
): Array<{ name: string; description: string; destructive: boolean; configured: boolean }> {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    destructive: t.destructive,
    configured: t.isConfigured(env),
  }));
}

/** The provider-independent description the completion seam wants. */
export function toolSpecs(tools: AgentTool[]): ToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input: t.input }));
}
