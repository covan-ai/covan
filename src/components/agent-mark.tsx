import type { ReactNode } from "react";
import { lookup, msg, useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { cn } from "@/lib/utils";

/**
 * An agent's face: one of eight brush-drawn marks in the ink colour on a white
 * tile, or its two-letter monogram on the grey tile when it has none.
 *
 * DESIGN.md §5. The mark fills 72% of its tile at every size, so the eye lands
 * on the same spot down a list. One ink, never a colour; people are round
 * (`Avatar`), workspaces and apps are grey tiles (`Tile`), and only agents get
 * a mark. An unknown name — a mark a later build dropped — falls back to the
 * monogram rather than an empty box.
 *
 * The paths are the board's, drawn on a 64 box with round caps; `currentColor`
 * so the mark inverts with the ink in the dark theme.
 */
export const AGENT_MARKS = [
  "headset",
  "fox",
  "owl",
  "bear",
  "cat",
  "robot",
  "penguin",
  "blob",
] as const;

export type AgentMarkName = (typeof AGENT_MARKS)[number];

/** What the picker calls each mark, for its accessible name. English keys: `lookup(t, …)`. */
export const AGENT_MARK_LABELS: Record<AgentMarkName, string> = {
  headset: msg("Headset"),
  fox: msg("Fox"),
  owl: msg("Owl"),
  bear: msg("Bear"),
  cat: msg("Cat"),
  robot: msg("Robot"),
  penguin: msg("Penguin"),
  blob: msg("Blob"),
};

export function isAgentMark(value: unknown): value is AgentMarkName {
  return typeof value === "string" && (AGENT_MARKS as readonly string[]).includes(value);
}

const PATHS: Record<AgentMarkName, ReactNode> = {
  headset: (
    <>
      <path d="M12 38a20 20 0 0 1 40 0" strokeWidth="6" />
      <path d="M12 38a20 20 0 0 1 10-17.3" strokeWidth="8" />
      <rect x="8" y="32" width="8" height="14" rx="3.5" fill="currentColor" strokeWidth="2" />
      <rect x="48" y="32" width="8" height="14" rx="3.5" fill="currentColor" strokeWidth="2" />
      <path d="M52 45c0 5-6 7-12 7" strokeWidth="4" />
      <path d="M26 38h.01M38 38h.01" strokeWidth="6" />
      <path d="M26 45q6 4 12 0" strokeWidth="4" />
    </>
  ),
  fox: (
    <>
      <path d="M14 28c6-5 12-7 18-7s12 2 18 7c-2 12-9 20-18 24c-9-4-16-12-18-24z" strokeWidth="5" />
      <path d="M32 52c-9-4-16-12-18-24" strokeWidth="7.5" />
      <path d="M15 28l-1-13 10 7zM49 28l1-13-10 7z" strokeWidth="5" fill="currentColor" />
      <path d="M25 36h.01M39 36h.01" strokeWidth="6" />
      <path d="M32 46h.01" strokeWidth="7" />
    </>
  ),
  owl: (
    <>
      <path d="M16 30c0-10 7-16 16-16s16 6 16 16v12c0 6-7 10-16 10s-16-4-16-10z" strokeWidth="5" />
      <path d="M16 42V30" strokeWidth="7.5" />
      <path d="M18 19l-3-7M46 19l3-7" strokeWidth="5" />
      <circle cx="25" cy="32" r="6" strokeWidth="4.5" />
      <circle cx="39" cy="32" r="6" strokeWidth="4.5" />
      <path d="M25 32h.01M39 32h.01" strokeWidth="5" />
      <path d="M30 43l2 4 2-4" strokeWidth="4" />
    </>
  ),
  bear: (
    <>
      <circle cx="32" cy="36" r="15" strokeWidth="5" />
      <path d="M17 36a15 15 0 0 1 7.5-13" strokeWidth="7.5" />
      <circle cx="20" cy="21" r="4.5" strokeWidth="5" />
      <circle cx="44" cy="21" r="4.5" strokeWidth="5" />
      <path d="M26 34h.01M38 34h.01" strokeWidth="6" />
      <path d="M32 41h.01" strokeWidth="7" />
    </>
  ),
  cat: (
    <>
      <path d="M14 34c0-9 8-15 18-15s18 6 18 15c0 10-8 17-18 17s-18-7-18-17z" strokeWidth="5" />
      <path d="M14 34c0 10 8 17 18 17" strokeWidth="7.5" />
      <path d="M17 26l-1-12 10 6zM47 26l1-12-10 6z" strokeWidth="5" fill="currentColor" />
      <path d="M25 35h.01M39 35h.01" strokeWidth="6" />
      <path d="M32 41h.01" strokeWidth="5" />
      <path d="M8 34l6 1M8 40l6-1M56 34l-6 1M56 40l-6-1" strokeWidth="3.5" />
    </>
  ),
  robot: (
    <>
      <rect x="16" y="22" width="32" height="28" rx="8" strokeWidth="5" />
      <path d="M16 39V33" strokeWidth="7.5" />
      <path d="M32 22v-7" strokeWidth="5" />
      <path d="M32 12h.01" strokeWidth="6.5" />
      <path d="M11 34v6M53 34v6" strokeWidth="5" />
      <path d="M25 36h.01M39 36h.01" strokeWidth="7" />
      <path d="M26 44h12" strokeWidth="4.5" />
    </>
  ),
  penguin: (
    <>
      <path d="M18 44c0-16 5-29 14-29s14 13 14 29c0 5-6 8-14 8s-14-3-14-8z" strokeWidth="5" />
      <path d="M18 44c0-7 1-13 3-18" strokeWidth="7.5" />
      <path d="M26 27h.01M38 27h.01" strokeWidth="6" />
      <path d="M28 32l4 4 4-4z" fill="currentColor" strokeWidth="3.5" />
      <path d="M17 33l-5 11M47 33l5 11" strokeWidth="5" />
      <path d="M26 52v4M38 52v4" strokeWidth="4.5" />
    </>
  ),
  blob: (
    <>
      <path d="M18 51V32c0-9 6-15 14-15s14 6 14 15v19l-5-4-4 4-5-4-5 4-4-4-5 4z" strokeWidth="5" />
      <path d="M18 40V32c0-5 2-9 5-12" strokeWidth="7.5" />
      <path d="M26 33h.01M38 33h.01" strokeWidth="6" />
    </>
  ),
};

export type AgentMarkSize = 16 | 20 | 24 | 36 | 40 | 56 | 64;

/** Box, radius and monogram size per tile size (DESIGN.md §5). */
const SIZES: Record<AgentMarkSize, string> = {
  16: "h-4 w-4 rounded-sm text-[8px]",
  20: "h-5 w-5 rounded-sm text-[9px]",
  24: "h-6 w-6 rounded-md text-[10px]",
  36: "h-9 w-9 rounded-lg text-[13px]",
  40: "h-10 w-10 rounded-xl text-[14px]",
  56: "h-14 w-14 rounded-2xl text-[18px]",
  64: "h-16 w-16 rounded-2xl text-[20px]",
};

/**
 * "Support" → "SU", "Sales ops" → "SO": two letters from the name, the first
 * of the first two words or the first two of a single word.
 */
export function agentMonogram(name: string | null | undefined, locale: string = "en"): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "–";
  if (words.length === 1) return words[0]!.slice(0, 2).toLocaleUpperCase(locale);
  return (words[0]!.charAt(0) + words[1]!.charAt(0)).toLocaleUpperCase(locale);
}

/** The bare mark, for a place that draws its own tile (the picker). */
export function AgentMarkGlyph({ mark, className }: { mark: AgentMarkName; className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("h-[72%] w-[72%]", className)}
    >
      {PATHS[mark]}
    </svg>
  );
}

export function AgentMark({
  agent,
  size = 24,
  className,
}: {
  agent: { name: string | null | undefined; avatar?: string | null };
  size?: AgentMarkSize;
  className?: string;
}) {
  const locale = useLocale();
  const mark = isAgentMark(agent.avatar) ? agent.avatar : null;
  if (!mark) {
    return (
      <span
        aria-hidden
        className={cn(
          "grid shrink-0 place-items-center bg-tile font-semibold tracking-[0.02em] text-tile-foreground",
          SIZES[size],
          className,
        )}
      >
        {agentMonogram(agent.name, locale)}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center border border-border bg-background text-foreground",
        SIZES[size],
        className,
      )}
    >
      <AgentMarkGlyph mark={mark} />
    </span>
  );
}

/**
 * The eight marks as a radio group: picked when an agent is created, changed
 * under Identity in its Configuration. 40px tiles in a dialog, 56px on the
 * welcome step; the chosen one has a 2px ink outline. Arrow keys move between
 * them, as a radio group's do.
 */
export function AgentMarkPicker({
  value,
  onChange,
  size = 40,
  label,
}: {
  value: string | null | undefined;
  onChange: (mark: AgentMarkName) => void;
  size?: 40 | 56;
  label?: string;
}) {
  const { t } = useTranslation();
  const selected = isAgentMark(value) ? value : null;
  const move = (from: AgentMarkName, step: number) => {
    const i = AGENT_MARKS.indexOf(from);
    const next = AGENT_MARKS[(i + step + AGENT_MARKS.length) % AGENT_MARKS.length]!;
    onChange(next);
    return next;
  };
  return (
    <div
      role="radiogroup"
      aria-label={label ?? t("Face")}
      className={cn("flex flex-wrap", size === 56 ? "gap-3" : "gap-2")}
    >
      {AGENT_MARKS.map((mark, i) => {
        const checked = mark === selected;
        // Roving tab stop: the checked mark, or the first when none is.
        const tabbable = checked || (selected === null && i === 0);
        return (
          <button
            key={mark}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={lookup(t, AGENT_MARK_LABELS[mark])}
            tabIndex={tabbable ? 0 : -1}
            onClick={() => onChange(mark)}
            onKeyDown={(e) => {
              const step =
                e.key === "ArrowRight" || e.key === "ArrowDown"
                  ? 1
                  : e.key === "ArrowLeft" || e.key === "ArrowUp"
                    ? -1
                    : 0;
              if (step === 0) return;
              e.preventDefault();
              const next = move(mark, step);
              const group = e.currentTarget.parentElement;
              group
                ?.querySelector<HTMLButtonElement>(
                  `[aria-label="${lookup(t, AGENT_MARK_LABELS[next])}"]`,
                )
                ?.focus();
            }}
            className={cn(
              "grid shrink-0 place-items-center border border-border bg-background text-foreground outline-offset-2 transition-colors duration-150 hover:border-input focus-visible:outline-2 focus-visible:outline-ring",
              SIZES[size],
              checked && "outline-2 outline-foreground",
            )}
          >
            <AgentMarkGlyph mark={mark} />
          </button>
        );
      })}
    </div>
  );
}
