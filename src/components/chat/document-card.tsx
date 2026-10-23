import { FileText } from "lucide-react";
import type { DocumentJob } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";
import { SectionSquares } from "./document-progress";
import { statusLine } from "./use-document-jobs";

/**
 * A document the agent is writing, in the conversation.
 *
 * Under the reply that said it was being written, so the transcript keeps the
 * document where it was asked for — and it stays there after a reload, read
 * from the jobs rather than from the turn's stream. The whole row opens the
 * document beside the conversation, where it fills in section by section.
 */
export function DocumentCard({
  job,
  onOpen,
  className,
}: {
  job: DocumentJob;
  onOpen: (jobId: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const failed = job.status === "failed";
  return (
    <button
      type="button"
      onClick={() => onOpen(job.id)}
      aria-label={t("Open {{title}}", { title: job.title })}
      className={cn(
        "flex w-full max-w-xl items-center gap-3.5 rounded-lg border border-hairline bg-background px-4 py-3.5 text-left transition-colors duration-200 hover:bg-surface-hover",
        className,
      )}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-surface">
        <FileText className="h-4 w-4 text-muted-foreground" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-base font-semibold leading-tight [overflow-wrap:anywhere]">
          {job.title}
        </span>
        <span
          className={cn(
            "text-meta leading-tight",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {statusLine(job, t)}
        </span>
        <SectionSquares job={job} />
      </span>
      <span className="shrink-0 text-meta font-medium text-muted-foreground">{t("Open")}</span>
    </button>
  );
}
