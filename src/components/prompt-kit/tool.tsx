"use client";

import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/*
 * prompt-kit's `tool`, copied and substantially rewritten.
 *
 * Upstream: https://www.prompt-kit.com/c/tool.json
 * MIT, Copyright (c) 2025 Julien Thibeaut. See THIRD-PARTY-NOTICES.md.
 *
 * WHAT WAS CHANGED, AND WHY.
 *
 * 1. `ToolPart` was retyped. Upstream describes an AI SDK tool part — `type`,
 *    `state` of four streaming values, `input`, `output`, `toolCallId`,
 *    `errorText`. Ours is a row of `message_steps`: a tool, one of four
 *    statuses, the request it was handed, the excerpt it returned, how long it
 *    took.
 *
 * 2. The whole palette went. Upstream paints each state in a literal Tailwind
 *    colour — `text-blue-500`, `bg-green-100`, `text-red-700` — and puts the
 *    state in a `rounded-full` pill. None of those are tokens of this system,
 *    which has one rule for a failed thing (a chip is never destructive; the
 *    failure is carried at the row level) and one for shape (squares, not
 *    circles). The status is NOT DRAWN HERE AT ALL: the trail row that opens
 *    this panel already draws it, with the two ambers whose distinction is
 *    shape rather than motion, and drawing it twice would have meant a second
 *    status vocabulary living in a copied file.
 *
 * 3. The trigger is a slot rather than a header this file builds. Upstream
 *    renders the tool's name and badge itself; here the caller passes the trail
 *    row it already has, so the row IS the trigger and there is one row.
 *
 * 4. `Call ID` is gone (we have no id to show, and `border-blue-200` on a
 *    divider was upstream's own slip), the spinner is gone with the rest of the
 *    palette, and BOTH payload blocks are capped and scroll. Upstream caps only
 *    its output block; `request` is arbitrary jsonb and a large tool call is
 *    long, which is the whole reason the trail's label truncates at 80.
 *
 * What is kept is the structure, which is what this file was taken for:
 * Collapsible / Trigger / Content, closed by default, with the two payload
 * blocks inside it and a chevron that turns.
 */

/** One settled step, in the shape `message_steps` and `AgentStepView` carry. */
export type ToolPart = {
  tool: string;
  status: "ok" | "failed" | "refused" | "pending";
  /** The parsed arguments. Never anything a person typed, never a credential — 0060. */
  request?: unknown;
  /** The first part of the result, capped at 2,000 characters by the worker. */
  resultExcerpt?: string | null;
  durationMs?: number | null;
};

/** `request` is jsonb; a string stays a string and everything else is printed. */
function format(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // A payload with a cycle in it is not worth losing the panel over.
    return String(value);
  }
}

/**
 * What the tool was handed, as text, or null when that is nothing.
 *
 * An empty object is nothing: `mapSteps` writes `request: {}` for a row that
 * stored none, so `{}` is the absence rather than a value, and a Sent block
 * containing two braces says the tool was handed an empty object — which is a
 * different and false claim.
 */
function sentText(part: ToolPart): string | null {
  const sent = part.request;
  if (sent === null || sent === undefined) return null;
  if (typeof sent === "string") return sent.trim().length > 0 ? sent : null;
  if (Array.isArray(sent)) return sent.length > 0 ? format(sent) : null;
  if (typeof sent === "object") return Object.keys(sent).length > 0 ? format(sent) : null;
  return format(sent);
}

/**
 * Whether there is anything behind this row worth a fold.
 *
 * A step whose request is an empty object and which returned no excerpt — a
 * row written before 0060, a `pending` one — has nothing to open onto, and a
 * disclosure that opens onto nothing is worse than no disclosure.
 */
export function hasPayload(part: ToolPart): boolean {
  return sentText(part) !== null || Boolean(part.resultExcerpt?.trim());
}

/**
 * The heading over what came back.
 *
 * For a step that failed or was refused, this panel is the only place on the
 * screen where the reason is readable at all, and labelling it "Returned"
 * would bury it. The trail row above already says "failed" / "not allowed";
 * this says where to look.
 */
function returnedLabel(status: ToolPart["status"]): string {
  if (status === "failed") return "What went wrong";
  if (status === "refused") return "Why it was not allowed";
  // A `pending` step has not returned anything: the harness stores the
  // PROPOSAL's summary in `result_excerpt` for one, so the text here is the
  // question somebody is being asked. "Returned" over it is the screen saying
  // something untrue about what happened, on the one surface where the thing
  // being approved is an email about to be sent. A confirmation nobody ever
  // answers stays `pending` in the stored transcript, so this is reachable.
  if (status === "pending") return "What it is asking";
  return "Returned";
}

function Block({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h4 className="text-xs uppercase tracking-[0.06em] text-muted-foreground">{title}</h4>
      {/* Capped and scrolling, both of them. Closed by default, so this costs
          layout only when somebody opens it. */}
      <pre className="max-h-48 overflow-auto rounded-md border border-hairline bg-muted/40 p-2.5 font-mono text-xs leading-[1.5] whitespace-pre-wrap [overflow-wrap:anywhere]">
        {body}
      </pre>
    </div>
  );
}

export type ToolProps = {
  part: ToolPart;
  /** The row this panel hangs off. It becomes the trigger. */
  trigger: ReactNode;
  defaultOpen?: boolean;
  className?: string;
};

function Tool({ part, trigger, defaultOpen = false, className }: ToolProps) {
  const [open, setOpen] = useState(defaultOpen);
  const sent = sentText(part);
  const returned = part.resultExcerpt?.trim() ? part.resultExcerpt : null;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn("min-w-0", className)}>
      <CollapsibleTrigger className="flex w-full min-w-0 cursor-pointer items-center gap-2 text-left">
        {trigger}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-3 w-3 shrink-0 text-muted-foreground/70 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none">
        <div className="mt-1.5 mb-2 flex min-w-0 flex-col gap-2.5 border-l border-hairline pl-3">
          {sent && <Block title="Sent" body={sent} />}
          {/* No empty Returned block. A step recorded before 0060 and a step
              still waiting both have nothing here, and an empty bordered box
              reads as "the tool returned nothing", which is a different and
              false claim. */}
          {returned && <Block title={returnedLabel(part.status)} body={returned} />}
          {typeof part.durationMs === "number" && (
            <span className="text-xs text-muted-foreground/70">
              took {(part.durationMs / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export { Tool };
