import { ChevronDown, X } from "lucide-react";
import { AgentMark } from "@/components/agent-mark";
import { Chip } from "@/components/chip";
import { Markdown } from "@/components/markdown";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { announceAnswerAction } from "@/lib/answer-events";
import type { DocumentJob } from "@/lib/api-client";
import { lastActivityLabel } from "@/lib/day-groups";
import { saveDocument, type ExportFormat } from "@/lib/document-export";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { SectionSquares } from "./document-progress";
import { isWriting, statusLine } from "./use-document-jobs";

/** What a filed document can be saved as. Format names, so not translated. */
const FORMATS: { format: ExportFormat; name: string }[] = [
  { format: "md", name: "Markdown" },
  { format: "docx", name: "Word" },
  { format: "pdf", name: "PDF" },
];

/**
 * A document the agent wrote, open over the thread (A22): a 56px bar with its
 * title, who wrote it, the folder it was filed in and what can be done with
 * it; the page itself, white on the well; and a 44px line saying who wrote it
 * when, and where it is.
 *
 * It reads the same poll as the card (`useDocumentJobs`), so a section that
 * lands shows up here and in the card's dots on the same tick, and the part
 * being written says so where it will appear. Once it is filed it can be
 * printed or saved as Markdown, Word or PDF; before that there is no file,
 * only the sections so far.
 */
export function DocumentPanel({
  job,
  agent,
  folderName,
  onOpenInKnowledge,
  onClose,
  onStop,
  onRetry,
}: {
  job: DocumentJob;
  /** Who wrote it, when the caller knows. */
  agent?: { name: string; avatar?: string | null };
  /** The folder it is filed in, when the caller knows. */
  folderName?: string | null;
  /** Where the filed document lives, for "Open in Knowledge". */
  onOpenInKnowledge?: () => void;
  onClose: () => void;
  onStop: (jobId: string) => void;
  onRetry: (jobId: string) => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const live = isWriting(job);
  const writingIndex = job.status === "writing" ? job.sections.findIndex((s) => !s.done) : -1;
  const canSave = job.status === "ready" && job.documentId !== null;
  const save = (format: ExportFormat) => {
    if (!job.documentId) return;
    void saveDocument(job.documentId, `${job.title}.md`, format, t);
    // A job knows its document but not the message that offered it, so the
    // event names the document and leaves the message out.
    announceAnswerAction({ action: "saved", documentId: job.documentId, format });
  };
  const when = Date.parse(job.finishedAt ?? job.updatedAt);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-hairline pr-3 pl-5">
        {/* Not a heading: over the thread the dialog's title names the box,
            and the page's own h1 below is the document's. */}
        <div className="min-w-0 truncate text-lead font-semibold">{job.title}</div>
        {agent && (
          <Chip className="hidden sm:inline-flex">
            <AgentMark agent={agent} size={16} />
            {agent.name}
          </Chip>
        )}
        {folderName && (
          <Chip tone="code" className="hidden md:inline-flex">
            {folderName}
          </Chip>
        )}
        {job.total > 0 && (
          <span className="hidden text-meta whitespace-nowrap text-muted-foreground md:inline">
            {t("{{count}} section", { count: job.total, defaultValue_other: "{{count}} sections" })}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {live && (
            <Button variant="secondary" size="sm" onClick={() => onStop(job.id)}>
              {t("Stop")}
            </Button>
          )}
          {(job.status === "failed" || job.status === "stopped") && (
            <Button variant="secondary" size="sm" onClick={() => onRetry(job.id)}>
              {job.status === "stopped" ? t("Continue") : t("Try again")}
            </Button>
          )}
          {canSave && (
            <>
              {onOpenInKnowledge && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="hidden md:inline-flex"
                  onClick={onOpenInKnowledge}
                >
                  {t("Open in Knowledge")}
                </Button>
              )}
              {/* The print page lays the document out for paper and prints
                  itself, "Save as PDF" included. */}
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  window.open(`/documents/${job.documentId}/print`, "_blank", "noopener")
                }
              >
                {t("Print")}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" size="sm">
                    {t("Download")} <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  {FORMATS.map(({ format, name }) => (
                    <DropdownMenuItem key={format} onClick={() => save(format)}>
                      {name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t("Close document")}
            className="text-muted-foreground"
          >
            <X />
          </Button>
        </div>
      </div>

      {/* The one scroller. `overscroll-contain` keeps a scroll that reaches
          the end of the document from carrying on into the page behind it. */}
      <div
        data-testid="document-scroll"
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain bg-surface px-3 pt-7 sm:px-6",
          live && "browser-live",
        )}
      >
        <article className="doc-reading mx-auto w-full max-w-[720px] rounded-t-sm border border-b-0 border-border bg-background px-6 pt-10 pb-12 shadow-xs sm:px-16 sm:pt-13">
          <h1 className="m-0 text-2xl leading-[1.2] font-semibold tracking-[-0.02em] [overflow-wrap:anywhere]">
            {job.title}
          </h1>

          {job.sections.length === 0 && live && (
            <p className="mt-6 text-meta text-muted-foreground">
              {t(
                "Reading the conversation and the team’s documents to plan it. You can close this — it keeps being written, and will be here when you come back.",
              )}
            </p>
          )}

          {job.sections.map((section, i) => (
            <section key={section.index} className="mt-6">
              <h2
                className={cn("text-title font-semibold", !section.done && "text-muted-foreground")}
              >
                {section.heading}
              </h2>
              {section.done ? (
                <Markdown content={section.body} className="mt-2" />
              ) : i === writingIndex ? (
                <p className="mt-2 flex items-center gap-2 text-meta text-muted-foreground">
                  <StatusDot state="running" />
                  {t("Being written…")}
                </p>
              ) : null}
            </section>
          ))}
        </article>
      </div>

      <div className="flex h-11 shrink-0 items-center gap-4 border-t border-hairline px-5 text-meta whitespace-nowrap text-muted-foreground">
        {agent && (
          <span className="hidden truncate sm:inline">
            {t("Written by {{name}} · {{when}}", {
              name: agent.name,
              when: lastActivityLabel(when, undefined, t, locale),
            })}
          </span>
        )}
        <span className={cn("truncate", job.status === "failed" && "text-destructive")}>
          {statusLine(job, t)}
        </span>
        <SectionSquares job={job} className="ml-auto shrink-0" />
      </div>
    </div>
  );
}
