import type { DocumentJob } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/**
 * Where a document is, in words and in squares.
 *
 * One square per section, the step trail's marks at the scale of a document:
 * a written section is solid, the one being written is the running square
 * (`.step-running`), and the rest are outlines. Squares, never a spinner or a
 * bar (DESIGN.md: squares, not circles; one amber).
 */

export function SectionSquares({ job, className }: { job: DocumentJob; className?: string }) {
  if (job.sections.length === 0) return null;
  const writingIndex = job.status === "writing" ? job.sections.findIndex((s) => !s.done) : -1;
  return (
    <span
      className={cn("flex flex-wrap items-center gap-1", className)}
      role="img"
      aria-label={`${job.written} of ${job.total} sections written`}
    >
      {job.sections.map((section, i) => (
        <span
          key={section.index}
          title={section.heading}
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            section.done
              ? "bg-muted-foreground"
              : i === writingIndex
                ? "step-running"
                : "border border-border",
          )}
        />
      ))}
    </span>
  );
}
