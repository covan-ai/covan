import { lazy, Suspense, useState } from "react";
import { FileText, TriangleAlert } from "lucide-react";
// Lazy: the chip is under every answer and the dialog is opened from few of
// them, and the dialog brings the API client with it.
const DocumentPreviewDialog = lazy(() =>
  import("@/components/document-preview-dialog").then((m) => ({
    default: m.DocumentPreviewDialog,
  })),
);
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
  // A citation you cannot open is a claim you have to take on trust. With an
  // id the chip opens the document — the same preview the Knowledge tab uses,
  // with what the agent read of it one tab over. A name alone cannot be
  // resolved to a document without guessing, so that chip stays a label.
  const [open, setOpen] = useState(false);
  const Tag = source.id ? "button" : "span";

  return (
    <>
      <Tag
        {...(source.id
          ? {
              type: "button" as const,
              onClick: () => setOpen(true),
              "aria-label": `Open ${source.name}`,
            }
          : {})}
        title={age ? `${source.name} — uploaded ${age.label}` : source.name}
        className={cn(
          "inline-flex max-w-[260px] items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
          source.id && "transition-colors hover:border-foreground/30 hover:text-foreground",
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
      </Tag>
      {open && source.id ? (
        <Suspense fallback={null}>
          <DocumentPreviewDialog
            documentId={source.id}
            name={source.name}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      ) : null}
    </>
  );
}
