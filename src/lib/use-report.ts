import { useCallback, useState } from "react";
import { toast } from "sonner";
import { api, getAccessToken } from "@/lib/api-client";
import { useAgentsStore } from "@/lib/agents-store";

export type ReportReceipt = {
  documentId: string;
  name: string;
  indexed: boolean;
};

export type ReportWriter = {
  pending: boolean;
  receipt: ReportReceipt | null;
  /**
   * Lives here rather than inside the dialog because two things open it: the
   * composer button, and a bare `/report` typed into the message box.
   */
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  write: (instruction: string) => Promise<void>;
  dismiss: () => void;
  download: () => void;
  /**
   * Report content for live preview. Loaded after the report is written.
   */
  content: string | null;
  loadingContent: boolean;
};

/**
 * Writing the conversation up as a document.
 *
 * Shaped like `useChatUploads` next door, and for the same reason: what the
 * request produced is a fact that outlives a toast. A report is born with no
 * embeddings, and whether that matters is a decision its reader makes after
 * reading it — so the receipt says "Not indexed" and stays on screen rather
 * than sliding away in three seconds.
 *
 * One request, and a slow one. The model is writing a document rather than a
 * reply, which is tens of seconds; `pending` is what the composer uses to say
 * so, because a button that looks idle for a minute reads as a button that did
 * nothing.
 */
export function useReportWriter(
  sessionId: string | null,
  agent: { id: string; name: string },
): ReportWriter {
  const { writeReport } = useAgentsStore();
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<ReportReceipt | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);

  const write = useCallback(
    async (instruction: string) => {
      if (!sessionId || pending) return;

      setPending(true);
      setContent(null);
      try {
        const doc = await writeReport(sessionId, agent, instruction);
        const rec = { documentId: doc.id, name: doc.name, indexed: doc.indexed };
        setReceipt(rec);

        // Load content for preview
        setLoadingContent(true);
        try {
          const token = await getAccessToken();
          const response = await fetch(
            `${import.meta.env.VITE_API_URL}/documents/${doc.id}/download`,
            {
              headers: token ? { Authorization: `Bearer ${token}` } : {},
            },
          );
          if (response.ok) {
            const blob = await response.blob();
            const text = await blob.text();
            setContent(text);
          }
        } catch (err) {
          console.error("Failed to load report content:", err);
        } finally {
          setLoadingContent(false);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        toast.error(
          message ? `Couldn't write the report: ${message}` : "Couldn't write the report",
        );
      } finally {
        setPending(false);
      }
    },
    [sessionId, pending, writeReport, agent],
  );

  const download = useCallback(() => {
    if (!receipt) return;
    void api.documents
      .download(receipt.documentId, receipt.name)
      .catch(() => toast.error("Couldn't download the report"));
  }, [receipt]);

  const dismiss = useCallback(() => {
    setReceipt(null);
    setContent(null);
  }, []);

  return {
    pending,
    receipt,
    dialogOpen,
    setDialogOpen,
    write,
    dismiss,
    download,
    content,
    loadingContent,
  };
}
