import { FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/markdown";
import type { DocumentJob } from "@/lib/api-client";
import { saveDocument, type ExportFormat } from "@/lib/document-export";
import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/status-dot";
import { SectionSquares } from "./document-progress";
import { isWriting, statusLine } from "./use-document-jobs";

/**
 * A document beside the conversation, filling in as it is written.
 *
 * It reads the same poll as the card (`useDocumentJobs`), so a section that
 * lands shows up here and in the card's squares on the same tick. While the
 * document is being written the panel carries the live hairline the browser
 * panel uses (`.browser-live`) — the running square's rule at panel scale —
 * and the part being written says so where it will appear.
 *
 * Once it is filed it can be saved as Markdown, Word or PDF; before that there
 * is no file to save, only the sections so far.
 */
export function DocumentPanel({
  job,
  onClose,
  onStop,
  onRetry,
}: {
  job: DocumentJob;
  onClose: () => void;
  onStop: (jobId: string) => void;
  onRetry: (jobId: string) => void;
}) {
  const live = isWriting(job);
  const writingIndex = job.status === "writing" ? job.sections.findIndex((s) => !s.done) : -1;
  const canSave = job.status === "ready" && job.documentId !== null;
  const save = (format: ExportFormat) => {
    if (job.documentId) void saveDocument(job.documentId, `${job.title}.md`, format);
  };

  return (
    <div
      className={cn(
        // `min-h-0` and `overflow-hidden` hold the panel to the height it was
        // given, so the document scrolls inside it rather than growing past
        // the screen and taking the page with it.
        "relative flex h-full min-h-0 flex-col overflow-hidden border-l border-border",
        live && "browser-live",
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">Document</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {live && (
            <Button variant="ghost" size="sm" onClick={() => onStop(job.id)}>
              Stop
            </Button>
          )}
          {(job.status === "failed" || job.status === "stopped") && (
            <Button variant="ghost" size="sm" onClick={() => onRetry(job.id)}>
              {job.status === "stopped" ? "Continue" : "Try again"}
            </Button>
          )}
          {canSave && (
            <>
              <Button variant="ghost" size="sm" onClick={() => save("md")}>
                Markdown
              </Button>
              <Button variant="ghost" size="sm" onClick={() => save("docx")}>
                Word
              </Button>
              <Button variant="ghost" size="sm" onClick={() => save("pdf")}>
                PDF
              </Button>
            </>
          )}
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close document">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* The one scroller. `overscroll-contain` keeps a scroll that reaches
          the end of the document from carrying on into the page behind it. */}
      <div
        data-testid="document-scroll"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-6"
      >
        <article className="doc-reading mx-auto max-w-2xl">
          <h1 className="text-title-lg font-semibold [overflow-wrap:anywhere]">{job.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span
              className={cn(
                "text-meta",
                job.status === "failed" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {statusLine(job)}
            </span>
            <SectionSquares job={job} />
          </div>

          {job.sections.length === 0 && live && (
            <p className="mt-8 text-meta text-muted-foreground">
              Reading the conversation and the team&rsquo;s documents to plan it. You can close this
              tab — it keeps being written, and will be here when you come back.
            </p>
          )}

          {job.sections.map((section, i) => (
            <section key={section.index} className="mt-8">
              <h2
                className={cn("text-title font-semibold", !section.done && "text-muted-foreground")}
              >
                {section.heading}
              </h2>
              {section.done ? (
                <Markdown content={section.body} className="mt-3" />
              ) : i === writingIndex ? (
                <p className="mt-3 flex items-center gap-2 text-meta text-muted-foreground">
                  <StatusDot state="running" />
                  Being written…
                </p>
              ) : null}
            </section>
          ))}
        </article>
      </div>
    </div>
  );
}
