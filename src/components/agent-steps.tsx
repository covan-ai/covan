import type { ReactNode } from "react";
import { Check, Loader2, Minus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
};

const WORDS: Record<AgentStepView["status"], string> = {
  running: "running",
  ok: "done",
  failed: "failed",
  refused: "not allowed",
  pending: "waiting for you",
};

function Mark({ status }: { status: AgentStepView["status"] }) {
  if (status === "running") {
    return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />;
  }
  if (status === "ok") return <Check className="h-3 w-3 shrink-0 text-muted-foreground" />;
  if (status === "failed") return <X className="h-3 w-3 shrink-0 text-destructive" />;
  if (status === "refused") return <Minus className="h-3 w-3 shrink-0 text-muted-foreground" />;
  // Waiting. A filled square rather than an outline: the amber says "this one
  // is yours", and it is the only amber in the trail.
  return <span className="h-2 w-2 shrink-0 rounded-[2px] bg-accent-orange" />;
}

/**
 * The trail itself.
 *
 * One row per step rather than a count, because the useful question is "what
 * did it look at" and a count cannot answer it. Capped in height rather than
 * in number: eight steps is the budget, eight rows is a paragraph, and hiding
 * the middle of a short list to save four lines would cost more than it saved.
 */
export function StepTrail({ steps, className }: { steps: AgentStepView[]; className?: string }) {
  if (steps.length === 0) return null;
  return (
    <ol className={cn("flex flex-col gap-1", className)}>
      {steps.map((step) => (
        <li
          key={step.index}
          className="flex items-center gap-2 text-xs leading-[1.45] text-muted-foreground"
        >
          <Mark status={step.status} />
          <span className="min-w-0 truncate">{step.label || step.tool}</span>
          <span className="shrink-0 text-muted-foreground/70">{WORDS[step.status]}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The same trail, under a reply that has already landed.
 *
 * A `<details>` rather than the open list: the live version answers "what is
 * it doing"; this one answers "what did it do", which is a question somebody
 * asks occasionally and should not have to scroll past the rest of the time.
 * The same shape the Thinking block uses two components over, for the same
 * reason — it opens and closes on its own and is already in the tab order.
 */
export function SettledSteps({ steps }: { steps: AgentStepView[] }) {
  if (steps.length === 0) return null;
  const failed = steps.filter((s) => s.status === "failed" || s.status === "refused").length;
  // The same shape and the same classes as the Thinking block in the chat
  // screen, deliberately: they are two foldable notes about one reply, and
  // two vocabularies for that would be a deviation rather than a choice.
  return (
    <details className="mt-3 rounded-lg border border-border bg-muted/40">
      <summary className="cursor-pointer select-none px-3 py-1.5 text-xs text-muted-foreground marker:text-muted-foreground hover:text-foreground">
        {steps.length === 1 ? "1 step" : `${steps.length} steps`}
        {failed > 0 ? ` · ${failed} did not complete` : ""}
      </summary>
      <div className="border-t border-border px-3 py-2">
        <StepTrail steps={steps} />
      </div>
    </details>
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
    // `kind` is how the worker tags the proposal for itself. The card already
    // names the tool above, so printing it again is a row that says nothing.
    ([key, value]) => key !== "kind" && value !== null && value !== undefined && value !== "",
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
 * The card.
 *
 * Radius 12, one step larger than the 10 of the rows inside it, because a
 * child inside a rounded parent takes one step larger and this is the parent.
 * No shadow: a border and a surface step, which is the whole of how a card
 * sits on this canvas.
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
 * `runToolProposal` in `lib/connections-api.ts`.
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
}: {
  pending: PendingConfirmation;
  busy: boolean;
  onAnswer: (approve: boolean) => void;
  standing?: { label: string; onChoose: () => void };
}) {
  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-[5px] h-2 w-2 shrink-0 rounded-[2px] bg-accent-orange" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-dm text-title font-medium leading-tight">
            {pending.summary || "The agent wants to do something."}
          </span>
          <span className="text-xs text-muted-foreground">
            {pending.tool} · nothing happens until you say so
          </span>
        </div>
      </div>

      <ProposalRows proposal={pending.proposal} />

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy} onClick={() => onAnswer(true)}>
          {busy ? "Working…" : "Approve"}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => onAnswer(false)}>
          Not now
        </Button>
        {standing ? (
          <Button variant="ghost" disabled={busy} onClick={standing.onChoose}>
            {standing.label}
          </Button>
        ) : null}
      </div>
      {standing ? (
        <p className="text-xs leading-[1.45] text-muted-foreground">
          Approving covers this service for the rest of this conversation. The third option applies
          to this operation on this agent until somebody removes it, on the Integrations page.
        </p>
      ) : null}
    </div>
  );
}
