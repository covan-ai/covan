import type { Option } from "@/lib/onboarding-options";
import { cn } from "@/lib/utils";

/**
 * One question, one tap. No Next button: picking the answer is the navigation,
 * which is what keeps three questions to about fifteen seconds.
 *
 * The selection marker is the system's square, and it is the only amber on the
 * screen apart from the step indicator's current dot.
 */
export function QuestionCard({
  title,
  subtitle,
  options,
  value,
  onSelect,
  onSkip,
  skipLabel,
}: {
  title: string;
  subtitle?: string;
  options: Option[];
  value: string | null;
  onSelect: (id: string) => void;
  onSkip?: () => void;
  skipLabel?: string;
}) {
  return (
    <div>
      {subtitle && <p className="mb-4 text-center text-sm text-muted-foreground">{subtitle}</p>}
      <div role="group" aria-label={title} className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {options.map((option) => {
          const selected = value === option.id;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(option.id)}
              className={cn(
                "flex items-center gap-3 rounded-xl border px-4 py-3.5 text-left text-[15px] transition-colors duration-200",
                "focus-visible:shadow-glow focus-visible:outline-none",
                selected
                  ? "border-border bg-surface"
                  : "border-hairline bg-card hover:bg-surface-hover",
              )}
            >
              <span
                aria-hidden
                className={cn("h-2 w-2 shrink-0", selected ? "bg-accent-orange" : "bg-border")}
              />
              <span className="min-w-0 flex-1">{option.label}</span>
            </button>
          );
        })}
      </div>

      {onSkip && (
        <div className="mt-5 text-center">
          <button
            type="button"
            onClick={onSkip}
            className="text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {skipLabel ?? "Skip"}
          </button>
        </div>
      )}
    </div>
  );
}
