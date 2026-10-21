import type { KeyboardEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type Choice<T extends string> = {
  id: T;
  label: string;
  line: string;
  icon?: LucideIcon;
  /** An emoji in the tile instead of an icon — the ready-made assistants. */
  emoji?: string;
};

/**
 * One question, one answer: a radio group drawn as cards.
 *
 * Real radio semantics — `role="radiogroup"`, `role="radio"`, `aria-checked`,
 * a roving tab stop and arrow keys between the cards — because the brief's
 * "cards must take focus with the right roles" is what a screen reader needs
 * to know there is one answer to give here. Enter picks the card under focus
 * and advances, so the keyboard can get through this screen in two presses.
 *
 * The selected mark is the system's dot: 8px, round, amber when on. The card
 * itself goes to the inset surface with the full border, which is the same
 * selected treatment the old one-tap question used.
 */
export function ChoiceCards<T extends string>({
  name,
  options,
  value,
  onChange,
  onEnter,
}: {
  /** The group's accessible name. */
  name: string;
  options: Choice<T>[];
  value: T | null;
  onChange: (id: T) => void;
  /** Enter on a card: it is selected first, then this. */
  onEnter?: (id: T) => void;
}) {
  const focusIndex = Math.max(
    0,
    options.findIndex((o) => o.id === value),
  );

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const move = (to: number) => {
      e.preventDefault();
      const next = options[(to + options.length) % options.length];
      const el = e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
        `[data-choice="${next.id}"]`,
      );
      el?.focus();
      onChange(next.id);
    };
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        return move(index + 1);
      case "ArrowLeft":
      case "ArrowUp":
        return move(index - 1);
      case "Enter": {
        e.preventDefault();
        const id = options[index].id;
        onChange(id);
        onEnter?.(id);
        return;
      }
      case " ":
        e.preventDefault();
        onChange(options[index].id);
        return;
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={name}
      className={cn("grid grid-cols-1 gap-2.5", options.length > 2 && "sm:grid-cols-2")}
    >
      {options.map((option, index) => {
        const selected = value === option.id;
        const Icon = option.icon;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            data-choice={option.id}
            tabIndex={index === focusIndex ? 0 : -1}
            onClick={() => onChange(option.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              "flex items-start gap-3 rounded-lg border px-4 py-3.5 text-left transition-colors duration-200",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              selected
                ? "border-border bg-surface"
                : "border-hairline bg-card hover:bg-surface-hover",
            )}
          >
            {option.emoji ? (
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-surface text-lg">
                {option.emoji}
              </span>
            ) : Icon ? (
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-surface">
                <Icon className="h-4 w-4 text-muted-foreground" />
              </span>
            ) : null}
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-tight">{option.label}</span>
              <span className="text-meta leading-[1.45] text-muted-foreground">{option.line}</span>
            </span>
            <span
              aria-hidden
              className={cn(
                "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                selected ? "bg-brand" : "bg-border",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
