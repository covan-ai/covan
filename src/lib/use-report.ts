import { useCallback, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useAgentsStore } from "@/lib/agents-store";

export type ReportReceipt = {
  documentId: string;
  name: string;
  indexed: boolean;
};

export type ReportWriter = {
  pending: boolean;
  receipt: ReportReceipt | null;
  write: (instruction: string) => Promise<void>;
  dismiss: () => void;
  download: () => void;
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

  const write = useCallback(
    async (instruction: string) => {
      if (!sessionId || pending) return;

      setPending(true);
      try {
        const doc = await writeReport(sessionId, agent, instruction);
        setReceipt({ documentId: doc.id, name: doc.name, indexed: doc.indexed });
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

  return { pending, receipt, write, dismiss: () => setReceipt(null), download };
}
