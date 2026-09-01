import { FileText, TriangleAlert } from "lucide-react";
import { documentAge, STALE_AFTER_DAYS } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

/**
 * One document under an answer, with its age.
 *
 * The chip has always made an answer checkable — that is what a citation is for
 * — but it said which file and not how old it is, and those are different
 * questions. Retrieval is working as designed when a process document written
 * in January comes back as the best match for a January question in September:
 * it *is* the best match. Nothing else in the interface was in a position to
 * mention that the answer is nine months old.
 *
 * The date is when the document was uploaded, and for a document that is the
 * whole of freshness — nothing updates one in place, so a file uploaded in
 * January is exactly the January file today.
 *
 * A chip with no date is not a bug. Replies written before ids were stored cite
 * by name alone, and a name cannot be resolved back to a document without
 * guessing; so can a document that has since been deleted. Both keep their
 * citation and say nothing about age, which is the honest half.
 */
export function SourceChip({
  source,
  uploadedAt,
}: {
  source: { id: string | null; name: string };
  uploadedAt?: number;
}) {
  const age = uploadedAt === undefined ? null : documentAge(uploadedAt);

  return (
    <span
      title={age ? `${source.name} — uploaded ${age.label}` : source.name}
      className={cn(
        "inline-flex max-w-[260px] items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]",
        age?.stale
          ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          : "border-hairline bg-popover text-muted-foreground",
      )}
    >
      {age?.stale ? (
        <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden />
      ) : (
        <FileText className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="truncate">{source.name}</span>
      {age && (
        <span className={cn("shrink-0", age.stale ? "font-medium" : "opacity-70")}>
          {age.label}
        </span>
      )}
      {age?.stale && (
        // Said in words as well as in colour. The whole point is a reader
        // noticing, and colour alone reaches neither a screen reader nor
        // somebody who cannot tell amber from grey.
        <span className="sr-only">
          — older than {STALE_AFTER_DAYS} days; check it is still current
        </span>
      )}
    </span>
  );
}
