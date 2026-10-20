import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { canFileDocuments } from "../../types";
import { complete as realComplete } from "../completion";
import type { CompletionMessage, CompletionUsage } from "../completion";
import { resolveModel } from "../models";
import { buildSystemPrefix, reasoningEffortFor, temperatureFor } from "../prompt";
import { promptOverrides, type PromptOverrides } from "../prompt-overrides";
import {
  completionSpend,
  embeddingSpend,
  entitlementsFor,
  spends,
  type Entitlements,
  type Spend,
} from "../entitlements";
import { embeddingModel } from "../embeddings";
import { reportFileName } from "../report";
import type { HistoryTurn } from "../history";
import { fileGeneratedDocument as realFile } from "./file";
import {
  assembleDocument,
  parseOutline,
  stripLeadingHeading,
  type OutlineSection,
} from "./outline";

/**
 * The document engine: one unit of work on one job, and nothing more.
 *
 * A unit is the outline, or one section, or filing the finished document.
 * Whoever calls this — the Durable Object's alarm, the timer on Node, the open
 * tab's poll, the cron — claims the job first (`claim_document_job`, 0102), so
 * any number of them can fire at once and exactly one does the work. The claim
 * is a lease rather than a flag: a worker that dies mid-section holds the job
 * for `LEASE` at most, and the next clock to come along picks it up at the
 * section that was never saved.
 *
 * WHY ONE UNIT PER CALL. Every call is then one model call and a handful of
 * writes, which fits any invocation this product runs in — a Durable Object
 * alarm, a request on Workers Free, a cron tick that has other work to do —
 * and a failure costs one section rather than the document. That is the
 * difference from the old Report button, which was one 8,192-token call that
 * either produced the whole document or nothing (covan-ai/covan-cloud#331).
 */

/** How long one unit may hold a job before another clock may take it. */
export const LEASE = "5 minutes";

/** Failures in a row before a job is given up on. Reset by every success. */
export const MAX_ATTEMPTS = 3;

/** Output ceiling for one section, and how many times it may run out of room. */
export const SECTION_MAX_TOKENS = 4096;
export const SECTION_CONTINUATIONS = 1;
export const OUTLINE_MAX_TOKENS = 1500;

/** How much of the previous section a section call is shown, for continuity. */
export const PREVIOUS_TAIL_CHARS = 1500;

/** Chunk geometry for a filed document: the report route's, for its reasons. */
export const DOCUMENT_CHUNK_SIZE = 2400;
export const DOCUMENT_CHUNK_OVERLAP = 200;

export const ACTIVE_STATUSES = ["queued", "writing", "filing"] as const;

export type JobStatus = "queued" | "writing" | "filing" | "ready" | "failed" | "stopped";

export type DocumentJob = {
  id: string;
  workspace_id: string;
  bundle_id: string;
  agent_id: string;
  session_id: string | null;
  requested_by: string;
  instruction: string;
  title: string;
  history: HistoryTurn[];
  sources: string;
  outline: OutlineSection[] | null;
  cursor: number;
  status: JobStatus;
  attempts: number;
  prompt_tokens: number;
  completion_tokens: number;
};

type SectionRow = { idx: number; heading: string; brief: string; body: string; status: string };

/**
 * What the caller should do next.
 *
 * `now` — there is more, and nothing to wait for. `at` — there is more, but
 * not before then (a backoff, or a lease somebody else holds). `none` — the
 * job is finished, failed or stopped, or does not exist.
 */
export type Advance = { next: "now" } | { next: "at"; at: number } | { next: "none" };

export type EngineDeps = {
  complete: typeof realComplete;
  fileDocument: typeof realFile;
  entitlements: (env: RoutineEnv) => Entitlements;
  now: () => number;
};

const defaults: EngineDeps = {
  complete: realComplete,
  fileDocument: realFile,
  entitlements: entitlementsFor,
  now: () => Date.now(),
};

/** Seconds to wait after the n-th failure in a row. */
function backoffMs(attempts: number): number {
  return Math.min(5 * 60_000, 15_000 * 2 ** Math.max(0, attempts - 1));
}

/** Retried while the lease is held elsewhere: about as long as a section takes. */
const BUSY_RETRY_MS = 20_000;

/** Waiting for a worker that can file (see `filing` below). */
const NO_STORE_RETRY_MS = 60_000;

const NO_CREDIT =
  "This workspace ran out of credits while the document was being written. " +
  "A workspace admin can add more, and then it can be retried from where it stopped.";

export async function advanceDocumentJob(
  service: SupabaseClient,
  env: RoutineEnv,
  jobId: string,
  overrides: Partial<EngineDeps> = {},
): Promise<Advance> {
  const deps = { ...defaults, ...overrides };

  const { data: claimed, error: claimError } = await service.rpc("claim_document_job", {
    p_id: jobId,
    p_lease: LEASE,
  });
  if (claimError) throw new Error(`claim_document_job: ${claimError.message}`);
  const job = (claimed as DocumentJob[] | null)?.[0];
  if (!job) return whyUnclaimed(service, jobId, deps);

  // A clock that arrives early (the tab's poll during a backoff) gives the
  // job straight back rather than spending the attempt the backoff is for.
  const due = Date.parse((job as unknown as { next_run_at: string }).next_run_at);
  if (Number.isFinite(due) && due > deps.now()) {
    await release(service, job.id, {});
    return { next: "at", at: due };
  }

  try {
    const verdict = await deps.entitlements(env).check(job.workspace_id);
    if (!verdict.allowed) {
      await finish(service, job.id, "failed", { error: NO_CREDIT });
      return { next: "none" };
    }

    if (job.status === "queued") {
      await writeOutline(service, env, job, deps);
      return { next: "now" };
    }
    if (job.status === "writing") {
      const done = await writeSection(service, env, job, deps);
      return done ? { next: "now" } : { next: "none" };
    }
    // filing
    // The cron Worker runs in a second account and cannot reach the bucket
    // (`canFileDocuments`, src/types.ts). The sections are all written by
    // now, so the job simply waits for a clock on the API Worker — the
    // Durable Object, the open tab, or this Worker's own cron.
    if (!canFileDocuments(env)) {
      await release(service, job.id, { next_run_at: iso(deps.now() + NO_STORE_RETRY_MS) });
      return { next: "at", at: deps.now() + NO_STORE_RETRY_MS };
    }
    await fileDocument(service, env, job, deps);
    return { next: "none" };
  } catch (err) {
    const attempts = job.attempts + 1;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`document job ${job.id}: unit failed (attempt ${attempts})`, err);
    if (attempts >= MAX_ATTEMPTS) {
      await finish(service, job.id, "failed", {
        error: `The document could not be finished: ${message}`,
        attempts,
      });
      return { next: "none" };
    }
    const at = deps.now() + backoffMs(attempts);
    await release(service, job.id, { attempts, next_run_at: iso(at) });
    return { next: "at", at };
  }
}

/** Not claimable: somebody holds it, or it is over. */
async function whyUnclaimed(
  service: SupabaseClient,
  jobId: string,
  deps: EngineDeps,
): Promise<Advance> {
  const { data } = await service
    .from("document_jobs")
    .select("status")
    .eq("id", jobId)
    .maybeSingle();
  if (!data || !(ACTIVE_STATUSES as readonly string[]).includes(data.status)) {
    return { next: "none" };
  }
  return { next: "at", at: deps.now() + BUSY_RETRY_MS };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Lets go of the lease, with whatever the unit decided. Conditional on the job
 * still being active, so a person who pressed Stop while a section was being
 * written is not overwritten back to `writing` by the unit finishing.
 */
async function release(
  service: SupabaseClient,
  jobId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await service
    .from("document_jobs")
    .update({ lease_until: null, updated_at: new Date().toISOString(), ...patch })
    .eq("id", jobId)
    .in("status", ACTIVE_STATUSES as unknown as string[]);
  if (error) throw new Error(`document job update: ${error.message}`);
}

async function finish(
  service: SupabaseClient,
  jobId: string,
  status: "ready" | "failed",
  patch: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await service
    .from("document_jobs")
    .update({ status, lease_until: null, updated_at: now, finished_at: now, ...patch })
    .eq("id", jobId)
    .in("status", ACTIVE_STATUSES as unknown as string[]);
  if (error) console.error(`document job ${jobId}: could not record ${status}`, error);
}

type AgentRow = {
  persona: string | null;
  model: string | null;
  temperature: number | null;
  reasoning_effort: string | null;
};

async function loadAgent(service: SupabaseClient, job: DocumentJob): Promise<AgentRow> {
  // The job's own workspace, not the id alone: the service role answers to no
  // policy, so the scope is said here.
  const { data, error } = await service
    .from("agents")
    .select("persona, model, temperature, reasoning_effort")
    .eq("id", job.agent_id)
    .eq("workspace_id", job.workspace_id)
    .maybeSingle();
  if (error) throw new Error(`load agent: ${error.message}`);
  if (!data) throw new Error("the agent this document was asked of no longer exists");
  return data as AgentRow;
}

/** System, conversation, sources — the part every call of one job shares. */
function groundedMessages(
  job: DocumentJob,
  agent: AgentRow,
  now: Date,
  overrides: PromptOverrides,
): CompletionMessage[] {
  // The retrieval block, as the job saved it when it was asked for.
  const ragBlock = job.sources;
  return [
    {
      role: "system",
      content: buildSystemPrefix({
        persona: agent.persona,
        mode: "document",
        docNames: [],
        now,
        overrides,
      }),
    },
    ...(Array.isArray(job.history) ? job.history : []),
    // `user`, not `system`: quoted document text, not this server's own words.
    // See `lib/rag.ts` and the assembly comment in `routes/chat.ts`.
    ...(ragBlock.trim()
      ? [{ role: "user" as const, content: ragBlock, volatile: true as const }]
      : []),
  ];
}

/** Records one model call against the workspace, and on the job's counters. */
async function charge(
  service: SupabaseClient,
  env: RoutineEnv,
  job: DocumentJob,
  model: string,
  usage: CompletionUsage,
  deps: EngineDeps,
  extra: Spend[] = [],
): Promise<void> {
  try {
    await deps
      .entitlements(env)
      .record(job.workspace_id, spends(completionSpend(model, usage, "report"), ...extra), {
        userId: job.requested_by,
        sessionId: job.session_id ?? undefined,
      });
  } catch (err) {
    // `recordCredits`' rule: the money is spent and the words are written; a
    // counter that cannot be written must not throw the section away.
    console.error(`document job ${job.id}: could not record spend`, err);
  }
  job.prompt_tokens += usage.promptTokens ?? 0;
  job.completion_tokens += usage.completionTokens ?? 0;
}

async function writeOutline(
  service: SupabaseClient,
  env: RoutineEnv,
  job: DocumentJob,
  deps: EngineDeps,
): Promise<void> {
  const agent = await loadAgent(service, job);
  const model = resolveModel(agent.model, env);

  const result = await deps.complete(env, {
    model,
    json: true,
    maxTokens: OUTLINE_MAX_TOKENS,
    reasoningEffort: reasoningEffortFor(agent.reasoning_effort),
    messages: [
      ...groundedMessages(job, agent, new Date(deps.now()), await promptOverrides(env)),
      { role: "user", content: outlineRequest(job) },
    ],
  });
  await charge(service, env, job, model, result.usage, deps);

  const outline = parseOutline(result.text, job.title);

  const { error: sectionError } = await service.from("document_sections").upsert(
    outline.sections.map((s, idx) => ({
      job_id: job.id,
      idx,
      heading: s.heading,
      brief: s.brief,
      body: "",
      status: "pending",
    })),
    { onConflict: "job_id,idx" },
  );
  if (sectionError) throw new Error(`save outline: ${sectionError.message}`);

  await release(service, job.id, {
    status: "writing",
    title: outline.title,
    outline: outline.sections,
    cursor: 0,
    attempts: 0,
    next_run_at: iso(deps.now()),
    prompt_tokens: job.prompt_tokens,
    completion_tokens: job.completion_tokens,
  });
}

export function outlineRequest(job: Pick<DocumentJob, "title" | "instruction">): string {
  return [
    `Plan a document. The request: ${job.instruction}`,
    `Working title: ${job.title}`,
    "",
    "Respond with one JSON object and nothing else, shaped like",
    '{"title": "…", "sections": [{"heading": "…", "brief": "…"}]}',
    "",
    "- `title`: the document's title, naming its subject.",
    "- `sections`: between 2 and 12 parts, in reading order. `heading` is the part's heading;",
    "  `brief` is one or two sentences on what that part must cover and which sources it draws on.",
    "- Size the plan to the request and to what the sources can support. A short request is a short document.",
    "- Write the title, headings and briefs in the language the request was made in.",
  ].join("\n");
}

/** Writes the section at `cursor`. False when the job ended meanwhile. */
async function writeSection(
  service: SupabaseClient,
  env: RoutineEnv,
  job: DocumentJob,
  deps: EngineDeps,
): Promise<boolean> {
  const { data: rows, error } = await service
    .from("document_sections")
    .select("idx, heading, brief, body, status")
    .eq("job_id", job.id)
    .order("idx");
  if (error) throw new Error(`load sections: ${error.message}`);
  const sections = (rows ?? []) as SectionRow[];

  if (job.cursor >= sections.length) {
    await release(service, job.id, { status: "filing", next_run_at: iso(deps.now()) });
    return true;
  }

  const agent = await loadAgent(service, job);
  const model = resolveModel(agent.model, env);
  const section = sections[job.cursor];
  const base: CompletionMessage[] = [
    ...groundedMessages(job, agent, new Date(deps.now()), await promptOverrides(env)),
    { role: "user", content: sectionRequest(job, sections, job.cursor) },
  ];

  let body = "";
  let messages = base;
  for (let pass = 0; pass <= SECTION_CONTINUATIONS; pass++) {
    const result = await deps.complete(env, {
      model,
      messages,
      maxTokens: SECTION_MAX_TOKENS,
      temperature: temperatureFor("document", agent.temperature),
      reasoningEffort: reasoningEffortFor(agent.reasoning_effort),
    });
    await charge(service, env, job, model, result.usage, deps);
    body += result.text;
    if (result.finishReason !== "length") break;
    // Ran out of room mid-section. One more call picks up where it stopped,
    // rather than leaving a part that ends mid-sentence.
    messages = [
      ...base,
      { role: "assistant", content: body },
      {
        role: "user",
        content:
          "Continue exactly where you stopped, mid-sentence if need be. Do not repeat anything.",
      },
    ];
  }

  const text = stripLeadingHeading(body);
  if (!text) throw new Error(`the model wrote nothing for "${section.heading}"`);

  const { error: saveError } = await service
    .from("document_sections")
    .update({ body: text, status: "done", updated_at: new Date().toISOString() })
    .eq("job_id", job.id)
    .eq("idx", section.idx);
  if (saveError) throw new Error(`save section: ${saveError.message}`);

  const next = job.cursor + 1;
  await release(service, job.id, {
    cursor: next,
    status: next >= sections.length ? "filing" : "writing",
    attempts: 0,
    next_run_at: iso(deps.now()),
    prompt_tokens: job.prompt_tokens,
    completion_tokens: job.completion_tokens,
  });
  return true;
}

export function sectionRequest(
  job: Pick<DocumentJob, "title" | "instruction">,
  sections: Array<Pick<SectionRow, "heading" | "brief" | "body">>,
  index: number,
): string {
  const plan = sections
    .map((s, i) => `${i + 1}. ${s.heading}${s.brief ? ` — ${s.brief}` : ""}`)
    .join("\n");
  const previous = index > 0 ? sections[index - 1].body.trim() : "";
  const tail =
    previous.length > PREVIOUS_TAIL_CHARS
      ? `…${previous.slice(previous.length - PREVIOUS_TAIL_CHARS)}`
      : previous;
  const current = sections[index];

  return [
    `The document: "${job.title}". It was asked for as: ${job.instruction}`,
    "",
    "The plan:",
    plan,
    "",
    ...(tail
      ? [`The end of part ${index}, already written, so you can continue from it:`, tail, ""]
      : []),
    `Now write part ${index + 1} of ${sections.length}: "${current.heading}".`,
    current.brief ? `It must cover: ${current.brief}` : "",
    "Write only this part, without its heading; the parts before and after it are written separately.",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}

async function fileDocument(
  service: SupabaseClient,
  env: RoutineEnv,
  job: DocumentJob,
  deps: EngineDeps,
): Promise<void> {
  if (!canFileDocuments(env)) throw new Error("no document store bound");

  const { data: rows, error } = await service
    .from("document_sections")
    .select("idx, heading, body, status")
    .eq("job_id", job.id)
    .order("idx");
  if (error) throw new Error(`load sections: ${error.message}`);

  const sections = (rows ?? []) as SectionRow[];
  const text = assembleDocument(job.title, sections);
  const name = reportFileName(job.title, new Date(deps.now()).toISOString().slice(0, 10));

  const filed = await deps.fileDocument(service, env, {
    workspaceId: job.workspace_id,
    bundleId: job.bundle_id,
    name,
    text,
    createdBy: job.requested_by,
    chunkSize: DOCUMENT_CHUNK_SIZE,
    chunkOverlap: DOCUMENT_CHUNK_OVERLAP,
  });

  if (!filed.filed) {
    if (filed.reason === "bundle_gone") {
      await finish(service, job.id, "failed", {
        error: "The bundle this document was going into was deleted while it was being written.",
      });
      return;
    }
    throw new Error(`file the document: ${filed.note}`);
  }

  if (filed.indexTokens > 0) {
    try {
      await deps
        .entitlements(env)
        .record(
          job.workspace_id,
          spends(embeddingSpend(embeddingModel(env), filed.indexTokens, "report")),
          { userId: job.requested_by, sessionId: job.session_id ?? undefined },
        );
    } catch (err) {
      console.error(`document job ${job.id}: could not record indexing spend`, err);
    }
  }

  await finish(service, job.id, "ready", { document_id: filed.documentId, attempts: 0 });
}
