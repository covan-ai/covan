import { complete, extractJsonObject, type CompletionEnv } from "../completion";
import { completionSpend, spends, type Spend } from "../entitlements";
import { resolveModel, type ModelEnv } from "../models";
import type { ArrivalItem } from "./read";
import {
  KINDS,
  KIND_GUIDE,
  PROPOSAL_FOR,
  UNANSWERED_KINDS,
  isKind,
  type ArrivalKind,
} from "./taxonomy";

/**
 * Sorting what arrived into the ten kinds, and naming each for this person.
 *
 * Two model calls at most, both `gpt-4.1-mini` with `json: true`, in the shape
 * `clusterQuestions` (`routines/dispatcher.ts`) set for "a list in, labelled
 * groups out". Shaping, not thinking, so no agent's model is consulted;
 * `resolveModel` so an operator's override still wins.
 *
 * Counts and "never got a reply" are computed here from the readers' flags and
 * are never asked of the model. Whatever the model answers — a line it
 * skipped, a kind that does not exist, prose instead of JSON — becomes
 * `other` or no label. Nothing it says can fail a scan.
 *
 * Mail text rides in the user message, never the system one: it is
 * third-party text, and `summarise.ts` makes that argument for a watched page.
 */

/**
 * Lines per classify call. Small, and all sent at once: a scan runs inside
 * `waitUntil`'s thirty seconds on Workers, and a model writes its answer one
 * token at a time, so four short answers in parallel finish long before one
 * long one would (C1 of the branch review).
 */
export const CLASSIFY_BATCH = 50;
export const CLASSIFY_MODEL = "gpt-4.1-mini";
/** A bucket must hold more than this many items to be named by the model. */
export const LABEL_MIN = 2;
/** Subjects per kind sent to the label call. */
const LABEL_SUBJECTS = 30;
const EXAMPLES = 3;
/** An example subject is kept to this many characters. */
const EXAMPLE_CHARS = 200;
/** "Never got a reply" starts here: two days without an answer. */
const WAITING_MS = 2 * 86_400_000;

type Env = CompletionEnv & ModelEnv;

export type Bucket = {
  kind: ArrivalKind;
  /** "" until labelled, and for buckets too small to name: the client shows the kind's name. */
  label: string;
  count: number;
  unanswered: number;
  examples: string[];
  templateId: string | null;
};

function parsed(text: string): unknown {
  try {
    return JSON.parse(extractJsonObject(text));
  } catch {
    return null;
  }
}

function records(x: unknown, key: string): Record<string, unknown>[] {
  if (typeof x !== "object" || x === null) return [];
  const list = (x as Record<string, unknown>)[key];
  return Array.isArray(list)
    ? list.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    : [];
}

function classifyInstruction(selfDomains: string[]): string {
  const own = selfDomains.length
    ? `The person's own mail domains are: ${selfDomains.join(", ")}. Mail from those domains is "internal" unless it is a public mail provider such as gmail.com or outlook.com.`
    : 'Treat mail as "internal" only when it plainly comes from the person\'s own team.';
  return [
    "You sort the mail one person received into exactly one of these kinds:",
    ...KINDS.map((k) => `- ${k}: ${KIND_GUIDE[k]}`),
    own,
    'Each line is "<number>. from: <sender domain> · <subject> · <preview>". ' +
      'Respond with one JSON object of the shape {"items": [{"i": number, "kind": string}]}, ' +
      "one entry per line, where `i` is the line's number and `kind` is one of the ids above, exactly as written.",
  ].join("\n");
}

/**
 * One kind per item, in the same order as `items`. Events are `scheduling`
 * without a call (the spec's call 5); mail goes in batches of `CLASSIFY_BATCH`.
 */
export async function classifyItems(
  env: Env,
  items: ArrivalItem[],
  context: { selfDomains?: string[] } = {},
): Promise<{ kinds: ArrivalKind[]; spent: Spend[] }> {
  const kinds: ArrivalKind[] = items.map((item) =>
    item.source === "event" ? "scheduling" : "other",
  );
  const mail = items.flatMap((item, at) => (item.source === "mail" ? [at] : []));
  const spent: Spend[] = [];
  const model = resolveModel(CLASSIFY_MODEL, env);
  const system = classifyInstruction(context.selfDomains ?? []);

  const batches: number[][] = [];
  for (let start = 0; start < mail.length; start += CLASSIFY_BATCH) {
    batches.push(mail.slice(start, start + CLASSIFY_BATCH));
  }
  const answers = await Promise.all(
    batches.map((batch) => {
      const lines = batch.map((at, i) => {
        const item = items[at];
        return `${i}. from: ${item.domain || "unknown"} · ${item.subject} · ${item.snippet}`;
      });
      return complete(env, {
        model,
        json: true,
        maxTokens: 16 * batch.length + 256,
        messages: [
          { role: "system", content: system },
          { role: "user", content: lines.join("\n") },
        ],
      });
    }),
  );
  answers.forEach(({ text, usage }, b) => {
    const batch = batches[b];
    spent.push(...spends(completionSpend(model, usage, "arrivals")));
    for (const row of records(parsed(text), "items")) {
      const i = row.i;
      if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= batch.length) continue;
      if (isKind(row.kind)) kinds[batch[i]] = row.kind;
    }
  });
  return { kinds, spent };
}

/** The spec's rule: the last message is not the person's, and it is over two days old. */
function waiting(item: ArrivalItem, now: Date): boolean {
  if (item.fromMe) return false;
  const at = Date.parse(item.at);
  return Number.isFinite(at) && now.getTime() - at > WAITING_MS;
}

/** Counts per kind, largest first (ties in taxonomy order); kinds with nothing are left out. */
export function bucketise(items: ArrivalItem[], kinds: ArrivalKind[], now: Date): Bucket[] {
  const buckets: Bucket[] = [];
  for (const kind of KINDS) {
    const mine = items.filter((_, i) => kinds[i] === kind).sort((a, b) => b.at.localeCompare(a.at));
    if (mine.length === 0) continue;
    buckets.push({
      kind,
      label: "",
      count: mine.length,
      unanswered: UNANSWERED_KINDS.has(kind) ? mine.filter((item) => waiting(item, now)).length : 0,
      examples: mine
        .map((item) => item.subject.trim().slice(0, EXAMPLE_CHARS))
        .filter(Boolean)
        .slice(0, EXAMPLES),
      templateId: PROPOSAL_FOR[kind] ?? null,
    });
  }
  return buckets.sort((a, b) => b.count - a.count);
}

const LABEL_INSTRUCTION =
  "Below are the subjects of mail one person received, grouped under a kind id. " +
  "For each kind, write a label of two to six words naming what this person's mail of that kind is mostly about, " +
  "in the language the subjects are written in — never a quotation, never a person's name or address. " +
  "Pick up to three subjects that represent it best, by their zero-based number within the kind. " +
  'Respond with one JSON object of the shape {"buckets": [{"kind": string, "label": string, "examples": number[]}]}.';

/**
 * One call for every bucket bigger than `LABEL_MIN`. A bucket of one or two
 * keeps the kind's name (label "") and all its subjects as examples.
 */
export async function labelBuckets(
  env: Env,
  buckets: Bucket[],
  subjectsByKind: Map<ArrivalKind, readonly string[]>,
): Promise<{ buckets: Bucket[]; spent: Spend[] }> {
  const out = buckets.map((b) => ({ ...b }));
  for (const b of out) {
    if (b.count <= LABEL_MIN)
      b.examples = (subjectsByKind.get(b.kind) ?? b.examples).slice(0, EXAMPLES);
  }
  const named = out.filter(
    (b) => b.count > LABEL_MIN && (subjectsByKind.get(b.kind)?.length ?? 0) > 0,
  );
  if (named.length === 0) return { buckets: out, spent: [] };

  const model = resolveModel(CLASSIFY_MODEL, env);
  const sections = named.map((b) => {
    const subjects = (subjectsByKind.get(b.kind) ?? []).slice(0, LABEL_SUBJECTS);
    return [`## ${b.kind}`, ...subjects.map((s, i) => `${i}. ${s}`)].join("\n");
  });
  const { text, usage } = await complete(env, {
    model,
    json: true,
    maxTokens: 1024,
    messages: [
      { role: "system", content: LABEL_INSTRUCTION },
      { role: "user", content: sections.join("\n\n") },
    ],
  });
  const spent = spends(completionSpend(model, usage, "arrivals"));

  for (const row of records(parsed(text), "buckets")) {
    const bucket = named.find((b) => b.kind === row.kind);
    if (!bucket) continue;
    if (typeof row.label === "string") bucket.label = row.label.trim().slice(0, 80);
    const subjects = subjectsByKind.get(bucket.kind) ?? [];
    const picked = Array.isArray(row.examples)
      ? row.examples
          .filter(
            (i): i is number =>
              typeof i === "number" &&
              Number.isInteger(i) &&
              i >= 0 &&
              i < Math.min(subjects.length, LABEL_SUBJECTS),
          )
          .map((i) => subjects[i])
      : [];
    if (picked.length) bucket.examples = [...new Set(picked)].slice(0, EXAMPLES);
  }
  return { buckets: out, spent };
}

export function headline(buckets: Bucket[]): { total: number; unanswered: number } {
  return {
    total: buckets.reduce((n, b) => n + b.count, 0),
    unanswered: buckets.reduce((n, b) => n + b.unanswered, 0),
  };
}
