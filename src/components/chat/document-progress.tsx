import type { DocumentJob } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/**
 * Where a document is, in words and in dots.
 *
 * One dot per section, in the dot language of DESIGN.md §12: a written
 * section is the grey fill, the one being written is the running dot, and the
 * rest are grey rings. Never a spinner or a bar.
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
              ? "bg-dot-done"
              : i === writingIndex
                ? "dot-live bg-brand"
                : "border-2 border-dot-done",
          )}
        />
      ))}
    </span>
  );
}
