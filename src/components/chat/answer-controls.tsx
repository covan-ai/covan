import { ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ModelCost } from "@/components/model-cost";
import { costFor } from "@/lib/agent-meta";

/**
 * The two controls that are about an answer having been given more than once.
 *
 * Together because they are one thought in two halves — how to get another
 * answer, and how to get back to the ones already given — and because they sit
 * in the same strip. Neither closes over anything in the route: both take what
 * they show and hand back a choice.
 */

/**
 * Which take on an answer is showing, and how to get to the others.
 *
 * `‹ 2/3 ›` rather than a list, because the versions have no names and never
 * will: they are the same question answered twice. What somebody wants is to
 * flick between them and stop on the one they liked, which is two buttons and
 * a count.
 */
export function VersionPicker({
  versions,
  current,
  busy,
  onShow,
}: {
  versions: string[];
  current: string;
  busy: boolean;
  onShow: (id: string) => void;
}) {
  const at = versions.indexOf(current);
  // A chain that does not contain the message showing is a transcript and a
  // version list that disagree, and drawing `0/3` over it helps nobody.
  if (at === -1) return null;
  const step = (by: number) => onShow(versions[at + by]);
  return (
    <div className="mt-2 flex items-center gap-0.5 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={busy || at === 0}
        aria-label="Previous version of this answer"
        className="grid h-6 w-6 place-items-center rounded-md transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span className="tabular-nums" aria-label={`Version ${at + 1} of ${versions.length}`}>
        {at + 1}/{versions.length}
      </span>
      <button
        type="button"
        onClick={() => step(1)}
        disabled={busy || at === versions.length - 1}
        aria-label="Next version of this answer"
        className="grid h-6 w-6 place-items-center rounded-md transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * Answer again, somewhere else.
 *
 * Beside Regenerate rather than replacing it: the common press is "try again",
 * and burying it behind a menu to make room for a choice nobody makes most of
 * the time is a worse default. Absent entirely on a deployment that serves one
 * model, where the menu would have nothing in it.
 *
 * The prices are worth more here than in any settings screen: this is the one
 * model picker somebody uses with a bill in mind, because pressing it spends
 * again on a question that has already been answered once.
 */
export function RetryOn({
  models,
  costs,
  onPick,
}: {
  models: string[];
  costs: Record<string, number> | undefined;
  onPick: (model: string) => void;
}) {
  if (models.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Answer again on another model"
          aria-label="Answer again on another model"
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Sparkles className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {models.map((model) => (
          <DropdownMenuItem
            key={model}
            onSelect={() => onPick(model)}
            className="font-mono text-xs"
          >
            <span className="flex w-full items-center justify-between">
              <span>{model}</span>
              <ModelCost cost={costFor(costs, model)} />
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
