import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/status-dot";
import { stepTime, stepsSummary } from "@/lib/step-summary";
import type { DotState } from "@/lib/dot-states";
import { Tool, hasPayload, type ToolPart } from "@/components/prompt-kit/tool";
import { AppLogo } from "@/components/integrations/app-logo";
import { assetSrc } from "@/lib/asset-src";
import type { ToolConnection } from "@/lib/connections-api";
import { cn } from "@/lib/utils";
import { lookup, msg, useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";

/**
 * What an answer did before it wrote, and the card that stops it doing
 * something nobody agreed to.
 *
 * `DESIGN.md` is what shapes both, and three of its rules do most of the
 * work here:
 *
 * - **A chip is never destructive.** So a step that failed is not a red chip;
 *   the failure is carried at the row level, by an icon and a word, and the
 *   chip stays neutral. Amber is a pointer and there is already one on this
 *   screen.
 * - **Squares, not circles.** The status marks are 8px squares, which is also
 *   what makes four of them in a row read as a sequence rather than as
 *   bullets.
 * - **Sizes come from the ladder.** `text-xs` for the marks and counts,
 *   `text-meta` for the sentence in the card. No literal sizes.
 */

export type AgentStepView = {
  index: number;
  tool: string;
  status: "running" | "ok" | "failed" | "refused" | "pending";
  /** One line: the tool and, where there is one, what it was pointed at. */
  label: string;
  /**
   * How long it took, or null for a step recorded before the column existed.
   *
   * Null and zero are different answers, which is why the summary omits the
   * figure entirely rather than printing "0.0s" — a measurement where there
   * was none.
   */
  durationMs?: number | null;
  /**
   * What the tool was handed, and the first part of what it gave back — the
   * two blocks the panel under a settled row opens onto.
   *
   * `request` is arbitrary jsonb and `resultExcerpt` is up to 2,000
   * characters, so both are rendered inside their own scroll; neither is
   * trusted to be short. 0060's header records that `request` is never
   * anything a person typed and never a credential — a tool is handed a
   * connection id and the secret is resolved on the worker — which is what
   * makes it safe to print as it stands.
   *
   * Both OPTIONAL, because a live row has neither and that absence is the
   * whole mechanism by which it is not expandable: `HarnessEvent`'s `step`
   * variant carries no payload, so there is nothing for a reader to open and
   * no decision to make about it. Required fields would have made every row in
   * every test about something else — duration, motion, the two ambers —
   * declare that it has no payload, which is a sentence none of them are
   * about. `toStepViews` always writes both, so every STORED row has them.
   */
  request?: unknown;
  resultExcerpt?: string | null;
};

const WORDS: Record<AgentStepView["status"], string> = {
  running: msg("running"),
  ok: msg("done"),
  failed: msg("failed"),
  refused: msg("not allowed"),
  pending: msg("waiting for you"),
};

/**
 * A step's mark, in the dot language of the whole app (DESIGN.md §12): a
 * running step is the filled amber dot that breathes, one waiting on somebody
 * is the amber ring, a finished one the grey fill, one that was not allowed a
 * grey ring, a failed one red. Fill against ring is the difference, so it
 * holds with motion switched off.
 */
const MARK: Record<AgentStepView["status"], DotState> = {
  running: "running",
  pending: "waiting",
  ok: "done",
  refused: "idle",
  failed: "failed",
};

/**
 * The connected service a step called, or null when it called none of them.
 *
 * Read off the workspace's own connections rather than off the step, because
 * the step does not say which application it reached — `run_tool` is handed a
 * connection id and an operation slug, and a live row is handed neither: its
 * `step` event carries a label and nothing else (see `toolPart`). So, in order:
 *
 * 1. `request.connectionId` — a stored row of any tool that takes one.
 * 2. `request.toolkit` — a stored `find_tool` row that named an application.
 * 3. The label's tail, which is what a LIVE row has. `labelFor` puts `slug`
 *    ahead of `connectionId`, so for `run_tool` it is the slug, or the id when
 *    there was no slug. The id is tried first, because it cannot be mistaken
 *    for anything; the slug only on `run_tool`, because another tool's tail is
 *    a query somebody's agent wrote, and an uppercase query is not an
 *    operation.
 *
 * The slug is matched by its toolkit prefix with the `_` boundary kept and the
 * LONGEST toolkit winning — `MICROSOFT_TEAMS_SEND_MESSAGE` is `microsoft_teams`
 * and not a `microsoft` somebody may also have connected. The same convention
 * `run_tool`'s guard 2 falls back to, for the same reason: here there is no
 * catalogue row to ask.
 *
 * No match is no logo, not a guess. A connection removed since the turn ran,
 * and every built-in tool, keep the row as it was.
 */
/** Folds an identifier's case. A slug or a toolkit name, never a word. */
function fold(id: string): string {
  // i18n-ignore: an identifier, not a word
  return id.toLowerCase();
}

export function stepService(
  step: AgentStepView,
  connections: ToolConnection[] | undefined,
): ToolConnection | null {
  if (!connections || connections.length === 0) return null;
  const request = isPlainObject(step.request) ? step.request : {};
  const byId = (id: unknown) =>
    typeof id === "string" ? (connections.find((c) => c.id === id) ?? null) : null;

  const stored = byId(request.connectionId);
  if (stored) return stored;

  if (typeof request.toolkit === "string") {
    const toolkit = fold(request.toolkit);
    const named = connections.find((c) => c.toolkitSlug && fold(c.toolkitSlug) === toolkit);
    if (named) return named;
  }

  const prefix = `${step.tool} · `;
  const tail =
    step.label.startsWith(prefix) && !step.label.endsWith("…")
      ? step.label.slice(prefix.length)
      : "";
  const live = byId(tail);
  if (live) return live;

  if (step.tool !== "run_tool") return null;
  const slug = fold(typeof request.slug === "string" ? request.slug : tail);
  if (!slug) return null;
  let best: ToolConnection | null = null;
  for (const c of connections) {
    const toolkit = c.toolkitSlug && fold(c.toolkitSlug);
    if (!toolkit || (slug !== toolkit && !slug.startsWith(`${toolkit}_`))) continue;
    if (!best || toolkit.length > (best.toolkitSlug?.length ?? 0)) best = c;
  }
  return best;
}

/**
 * The row itself (A13): the dot, the mark of the service it called when it
 * called one, what it was pointed at, and how long it took — or, with no time
 * recorded, how it ended.
 *
 * The mark sits AFTER the dot, not in place of it. The dot is the status and
 * the only thing on the row that moves; a logo is who was called, and swapping
 * one for the other would leave a row that says Gmail and not whether it
 * worked.
 */
function Row({ step, service }: { step: AgentStepView; service: ToolConnection | null }) {
  const { t } = useTranslation();
  const locale = useLocale();
  return (
    <>
      <StatusDot state={MARK[step.status]} />
      {service && <AppLogo src={assetSrc(service.logoPath)} name={service.label} size={20} />}
      <span
        className={cn(
          "min-w-0 truncate",
          step.status === "running" ? "font-medium text-foreground" : "text-foreground",
        )}
      >
        {step.label || step.tool}
      </span>
      <span className="ml-auto shrink-0 pl-2 text-muted-foreground tabular-nums">
        {typeof step.durationMs === "number"
          ? stepTime(step.durationMs, t, locale)
          : lookup(t, WORDS[step.status])}
      </span>
    </>
  );
}

/**
 * What a settled row can be opened onto, or null when there is nothing.
 *
 * A RUNNING row is null by construction rather than by a check on its
 * contents: `HarnessEvent`'s `step` variant carries `{ index, tool, status,
 * label }` and no payload, so there is nothing to open, and widening that
 * event would put every tool call's arguments and result into the SSE stream
 * of every open browser on every turn to buy the seconds before the turn
 * settles. Deferred deliberately — see the design, §1.
 */
function toolPart(step: AgentStepView): ToolPart | null {
  if (step.status === "running") return null;
  const part: ToolPart = {
    tool: step.tool,
    status: step.status,
    request: step.request,
    resultExcerpt: step.resultExcerpt,
    durationMs: step.durationMs,
  };
  return hasPayload(part) ? part : null;
}

/**
 * The trail itself.
 *
 * One row per step rather than a count, because the useful question is "what
 * did it look at" and a count cannot answer it. Capped in height rather than
 * in number: eight steps is the budget, eight rows is a paragraph, and hiding
 * the middle of a short list to save four lines would cost more than it saved.
 *
 * A row that has a payload behind it becomes a trigger and opens beneath
 * itself. A row that does not stays a plain `<li>` — which is every live row,
 * and every row written before 0060 — so the trail does not offer a fold onto
 * nothing. The two kinds sit in one list and read as one sequence, which is
 * why the mark, the label and the ending word are a fragment shared between
 * them rather than two copies of a row.
 */
export function StepTrail({
  steps,
  connections,
  boxed = false,
  className,
}: {
  steps: AgentStepView[];
  /** The workspace's connected services, for the mark on a row that called one. */
  connections?: ToolConnection[];
  /** In a bordered box, as a running turn draws it (A13). */
  boxed?: boolean;
  className?: string;
}) {
  if (steps.length === 0) return null;
  return (
    <ol
      className={cn(
        "flex flex-col",
        boxed && "rounded-xl border border-border px-2 py-1.5",
        className,
      )}
    >
      {steps.map((step) => {
        const part = toolPart(step);
        const service = stepService(step, connections);
        return (
          <li
            key={step.index}
            className={cn(
              "step-arrive min-w-0 px-1 text-meta",
              // The expandable row lays itself out inside the trigger, because
              // the panel below it is a sibling of the row and not of the mark.
              !part && "flex min-h-8 items-center gap-2.5",
            )}
          >
            {part ? (
              <Tool part={part} trigger={<Row step={step} service={service} />} />
            ) : (
              <Row step={step} service={service} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The same trail, under a reply that has already landed (A2): one line —
 * "› Searched Knowledge · 3 sources · 6 s" — that opens onto the rows.
 *
 * Folded, because the live version answers "what is it doing" and this one
 * answers "what did it do", which somebody asks occasionally and should not
 * have to scroll past the rest of the time.
 */
export function SettledSteps({
  steps,
  connections,
  sources = 0,
  className,
}: {
  steps: AgentStepView[];
  connections?: ToolConnection[];
  /** How many documents the reply cites, said on the line. */
  sources?: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="-ml-2 flex h-8 items-center gap-2.5 rounded-md px-2 text-meta font-medium text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
      >
        <ChevronRight
          aria-hidden
          className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span>{stepsSummary(steps, sources, t, locale)}</span>
      </button>
      {open && <StepTrail steps={steps} connections={connections} className="mt-1 mb-2 pl-1" />}
    </div>
  );
}

/**
 * A stored step, turned into a line somebody can read.
 *
 * The label is built here rather than stored, and the worker builds the same
 * one for the live event — two copies of a sentence, which is a real cost and
 * the cheaper of the two options. Storing it would put a rendered string in
 * `message_steps` alongside the structured `request` it was rendered from,
 * and the two would drift the first time the wording changed.
 */
/**
 * Kept byte-identical to `labelFor` in `worker/src/lib/harness/loop.ts`,
 * including the order — `slug` ahead of `connectionId`, so a stored `run_tool`
 * step reads `run_tool · GMAIL_SEND_EMAIL` rather than `run_tool · 8f3a…` and
 * matches the live event a person watched appear.
 */
const LABEL_KEYS = ["query", "sql", "path", "instruction", "summary", "slug", "connectionId"];

export function toStepViews(
  steps: Array<{
    index: number;
    tool: string;
    status: "ok" | "failed" | "refused" | "pending";
    request: unknown;
    durationMs?: number | null;
    resultExcerpt?: string | null;
  }>,
): AgentStepView[] {
  return steps.map((step) => {
    const request =
      step.request && typeof step.request === "object" && !Array.isArray(step.request)
        ? (step.request as Record<string, unknown>)
        : {};
    const first = LABEL_KEYS.map((key) => request[key]).find(
      (v) => typeof v === "string" && v.trim().length > 0,
    ) as string | undefined;
    const oneLine = first?.replace(/\s+/g, " ").trim() ?? "";
    return {
      index: step.index,
      tool: step.tool,
      status: step.status,
      durationMs: step.durationMs,
      // Carried, not consumed. The label above is built out of `request` and
      // for three migrations that was the only use anything made of it: the
      // object went into an 80-character line and the line was all that
      // reached the screen.
      request: step.request,
      resultExcerpt: step.resultExcerpt ?? null,
      label: oneLine
        ? `${step.tool} · ${oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine}`
        : step.tool,
    };
  });
}

/** What a person is being asked to agree to, as the worker sent it. */
export type PendingConfirmation = {
  id: string;
  tool: string;
  summary: string;
  proposal: unknown;
};

/** Whether a value is something this card can open up rather than print. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * One field of a proposal, rendered as a row.
 *
 * Deliberately generic. The card knows nothing about scheduling or email — a
 * tool returns a `proposal` and this prints it — because the next tool that
 * asks for confirmation must not need a second card, and 0058's approval queue
 * will want this one.
 *
 * NESTED OBJECTS ARE OPENED, not stringified, and that is not tidiness. Until
 * `run_tool` every proposal was flat, so one-line `JSON.stringify` was an
 * honest rendering of the worst case. A connected application's arguments are
 * not flat: the body of an email arrives as `arguments.body`, and printed as
 * `{"recipient_email":"…","body":"Hi Ana,\n\n…"}` on one line it is a blob
 * nobody reads — on the single highest-stakes surface in the product, where
 * somebody is being asked to approve sending it.
 *
 * One level deep, and no more. Two would invite an approval card that scrolls,
 * and anything with real structure below that is better read as JSON than as a
 * list of lists.
 */
function ProposalRows({ proposal, nested }: { proposal: unknown; nested?: boolean }): ReactNode {
  if (!isPlainObject(proposal)) return null;
  const rows = Object.entries(proposal).filter(
    // `kind` and `operation` are what the worker keeps in here for itself:
    // `kind` tags the proposal, and the card already names the tool above; and
    // `operation` is the catalogue row `run_tool` carries across the pause so
    // the call somebody approved can still be checked against its own schema
    // (see its proposal in the worker). A JSON Schema printed as a row would
    // be most of this card, on the one surface where every line has to earn
    // its place, and neither is something anybody is being asked about.
    //
    // Only at the top level, which is where the worker writes them. Below it
    // the keys belong to the far end — `arguments.operation` is an ordinary
    // parameter name — and hiding one of those would hide what is about to be
    // done on the one screen that exists to show it.
    ([key, value]) =>
      (nested || (key !== "kind" && key !== "operation")) &&
      value !== null &&
      value !== undefined &&
      value !== "",
  );
  if (rows.length === 0) return null;
  return (
    <dl className="flex flex-col gap-1.5">
      {rows.map(([key, value]) => (
        <div key={key} className="grid gap-1 sm:grid-cols-[140px_minmax(0,1fr)]">
          <dt className="text-xs uppercase tracking-[0.06em] text-muted-foreground">
            {/* Both conventions, because both arrive here. Covan's own
                proposals are camelCase (`firstRunAt`); a connected
                application's arguments are whatever that application calls
                them, which is usually snake_case (`recipient_email`). */}
            {key
              .replace(/[_-]+/g, " ")
              .replace(/([A-Z])/g, " $1")
              // i18n-ignore: a parameter name, not a word
              .toLowerCase()
              .trim()}
          </dt>
          <dd className="min-w-0 whitespace-pre-wrap text-meta leading-[1.45] [overflow-wrap:anywhere]">
            {isPlainObject(value) && !nested ? (
              // The border is the only thing marking the nesting: an indent
              // would fight the two-column grid at phone width, where the
              // columns have already stacked.
              <div className="border-l border-hairline pl-2.5">
                <ProposalRows proposal={value} nested />
              </div>
            ) : typeof value === "object" ? (
              JSON.stringify(value)
            ) : (
              String(value)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The card, drawn as A2's ask card: a bordered box, the amber ring of
 * something waiting on you, who is asking and what.
 *
 * Both buttons are real. "Not now" is not a dismissal — it goes to the same
 * endpoint with `approve: false`, so the agent is told and can say something
 * about it, rather than the turn ending in silence with a card still on
 * screen.
 *
 * `standing` is the third, optional action: approve this AND stop being asked.
 * It is a prop rather than something this card works out, because working it
 * out would mean knowing which tools have a standing permission to grant —
 * and this file's whole discipline is that it knows nothing about any tool.
 * The caller decides whether there is one to offer and to whom; see
 * `connectionOfProposal` and `mayGrantStanding` in `lib/connections-api.ts`.
 *
 * It is deliberately the LAST and quietest of the three. The safe answer
 * should be the easy one, and a button that reads "never ask me again" sitting
 * where the eye lands first is how people end up with standing permissions
 * they do not remember giving.
 */
export function ConfirmCard({
  pending,
  busy,
  onAnswer,
  standing,
  agentName,
}: {
  pending: PendingConfirmation;
  busy: boolean;
  onAnswer: (approve: boolean) => void;
  /** "Don't ask again for {{app}}", and the app it is about. */
  standing?: { label: string; onChoose: () => void; app: string };
  /** Who is asking: "Support is asking you". */
  agentName?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 flex items-start gap-3 rounded-xl border border-border p-4">
      <StatusDot state="waiting" className="mt-[7px]" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-medium">
            {agentName ? t("{{name}} is asking you", { name: agentName }) : t("Waiting for you")}
          </span>
          <span className="text-sm text-muted-foreground">
            {pending.summary || t("The agent wants to do something.")}
          </span>
          <span className="text-xs text-micro-foreground">
            {t("{{tool}} · nothing happens until you say so", { tool: pending.tool })}
          </span>
        </div>

        <ProposalRows proposal={pending.proposal} />

        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy} onClick={() => onAnswer(true)}>
            {busy ? t("Working…") : t("Approve")}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => onAnswer(false)}>
            {t("Not now")}
          </Button>
          {standing ? (
            <Button variant="ghost" disabled={busy} onClick={standing.onChoose}>
              {standing.label}
            </Button>
          ) : null}
        </div>
        {standing ? (
          /* Said at the moment somebody is deciding, so it has to be exactly
           what the two buttons do: a yes covers this operation, here, for the
           rest of the reply; the third lets the agent change things in this
           app unasked, on a schedule as well (0140), until somebody turns it
           off. */
          <p className="text-meta leading-[1.45] text-muted-foreground">
            {t(
              "Approving covers this operation for the rest of this reply. The third option lets {{agent}} change things in {{app}} without asking, in a conversation and on a schedule, until somebody turns it off on the Integrations page.",
              { agent: agentName ?? t("this agent"), app: standing.app },
            )}
          </p>
        ) : null}
      </div>
    </div>
  );
}
