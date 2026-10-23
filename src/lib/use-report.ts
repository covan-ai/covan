import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { api, type DocumentJob } from "@/lib/api-client";
import { documentJobsKey } from "@/components/chat/use-document-jobs";

export type ReportWriter = {
  /** Between pressing the button and the server saying the document has started. */
  pending: boolean;
  /**
   * Lives here rather than inside the dialog because two things open it: the
   * composer button, and a bare `/report` typed into the message box.
   */
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  write: (instruction: string) => Promise<void>;
};

/**
 * Asking for this conversation to be written up as a document.
 *
 * The request only starts it. The document engine writes it section by
 * section in the background (`worker/src/lib/docs/engine.ts`), and the
 * conversation follows it through the same poll that follows a document the
 * agent started itself (`useDocumentJobs`). So `pending` is a second, not a
 * minute — and nothing is lost if the tab closes while it is written.
 *
 * The new job is put into that poll's cache at once, so its card appears and
 * the poll starts without waiting for the next ask; `onStarted` opens it.
 */
export function useReportWriter(
  sessionId: string | null,
  onStarted: (jobId: string) => void,
): ReportWriter {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const write = useCallback(
    async (instruction: string) => {
      if (!sessionId || pending) return;
      setPending(true);
      try {
        const job = await api.reports.create(sessionId, { instruction });
        queryClient.setQueryData<DocumentJob[]>(documentJobsKey(sessionId), (prior) => [
          job,
          ...(prior ?? []).filter((j) => j.id !== job.id),
        ]);
        // The reports bundle may have just been made, and attached.
        void queryClient.invalidateQueries({ queryKey: ["bundles"] });
        void queryClient.invalidateQueries({ queryKey: ["agents"] });
        onStarted(job.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        toast.error(
          message
            ? t("Couldn't start the report: {{message}}", { message })
            : t("Couldn't start the report"),
        );
      } finally {
        setPending(false);
      }
    },
    [sessionId, pending, queryClient, onStarted, t],
  );

  return { pending, dialogOpen, setDialogOpen, write };
}
