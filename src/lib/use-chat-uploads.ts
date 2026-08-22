import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useAgentsStore } from "@/lib/agents-store";
import { validateUpload } from "@/lib/uploads";

export type ChatUploadReceipt = {
  id: string;
  name: string;
  documentId: string | null;
  state: "uploading" | "done" | "failed";
  progress: number;
  indexed: boolean;
  reason: string | null;
};

export type ChatUploads = {
  receipts: ChatUploadReceipt[];
  addFiles: (files: File[]) => Promise<void>;
  remove: (receiptId: string) => Promise<void>;
  dismiss: (receiptId: string) => void;
};

/**
 * Files dropped into a conversation: validate, resolve the agent's chat bundle
 * once, upload into it, and keep a receipt per file.
 *
 * The receipt is the part worth explaining. A toast would be the obvious place
 * for "uploaded" — and the wrong one, because the two things a person needs
 * from a chat upload both outlive a toast. Whether the file is retrievable at
 * all decides how to read the next answer, and whether the file should stay in
 * the agent's knowledge is a decision they can only make after seeing that
 * answer. So the receipt stays under the composer until it is acted on.
 */
export function useChatUploads(agent: { id: string; name: string }): ChatUploads {
  const { ensureChatBundle, uploadToBundle, removeDocument } = useAgentsStore();
  const [receipts, setReceipts] = useState<ChatUploadReceipt[]>([]);

  const patch = useCallback((id: string, next: Partial<ChatUploadReceipt>) => {
    setReceipts((prev) => prev.map((r) => (r.id === id ? { ...r, ...next } : r)));
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      const accepted: File[] = [];
      for (const file of files) {
        const check = validateUpload(file);
        if (check.ok) accepted.push(file);
        else toast.error(check.reason);
      }
      if (accepted.length === 0) return;

      // Resolved once for the whole batch: two files dropped together would
      // otherwise race, each finding no bundle and each creating one.
      let bundleId: string;
      try {
        bundleId = (await ensureChatBundle(agent)).id;
      } catch (e) {
        toast.error(
          e instanceof Error && e.message
            ? `Couldn't open a place to put the file: ${e.message}`
            : "Couldn't open a place to put the file.",
        );
        return;
      }

      const started = accepted.map((file) => {
        const id = `r_${crypto.randomUUID()}`;
        return { id, file };
      });
      setReceipts((prev) => [
        ...prev,
        ...started.map(({ id, file }) => ({
          id,
          name: file.name,
          documentId: null,
          state: "uploading" as const,
          progress: 0,
          indexed: false,
          reason: null,
        })),
      ]);

      await Promise.all(
        started.map(async ({ id, file }) => {
          try {
            const doc = await uploadToBundle(bundleId, file, (pct: number) =>
              patch(id, { progress: pct }),
            );
            patch(id, {
              documentId: doc.id,
              state: "done",
              progress: 100,
              indexed: doc.indexed,
            });
            if (!doc.indexed) {
              // Uploaded, stored, listed — and no passage in it can be matched.
              toast.warning(
                `${file.name} went in but could not be indexed, so answers won't be grounded in it.`,
              );
            }
          } catch (e) {
            patch(id, {
              state: "failed",
              reason: e instanceof Error ? e.message : "Upload failed",
            });
          }
        }),
      );
    },
    [agent, ensureChatBundle, uploadToBundle, patch],
  );

  const dismiss = useCallback((receiptId: string) => {
    setReceipts((prev) => prev.filter((r) => r.id !== receiptId));
  }, []);

  const remove = useCallback(
    async (receiptId: string) => {
      const receipt = receipts.find((r) => r.id === receiptId);
      if (receipt?.documentId) {
        try {
          await removeDocument(agent.id, receipt.documentId);
        } catch (e) {
          toast.error(
            e instanceof Error && e.message
              ? `Couldn't remove it: ${e.message}`
              : "Couldn't remove it.",
          );
          return;
        }
      }
      setReceipts((prev) => prev.filter((r) => r.id !== receiptId));
    },
    [agent.id, receipts, removeDocument],
  );

  return { receipts, addFiles, remove, dismiss };
}
