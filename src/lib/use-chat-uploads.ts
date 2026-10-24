import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { useAgentsStore } from "@/lib/agents-store";
import { findChatBundle } from "@/lib/chat-uploads";
import { indexingNow } from "@/lib/index-status";
import { validateUpload } from "@/lib/uploads";

export type ChatUploadReceipt = {
  id: string;
  name: string;
  documentId: string | null;
  bundleId: string | null;
  bundleName: string | null;
  state: "uploading" | "done" | "failed";
  progress: number;
  /**
   * Whether a passage in it can be matched now. Derived from `indexStatus`
   * when there is one; only a document indexed before jobs existed has none.
   */
  indexed: boolean;
  /**
   * Where its indexing job has got. Indexing runs after the upload returns, so
   * a fresh receipt starts at `queued` and moves on as the agents list is
   * re-read — which the store polls while any document is still indexing.
   */
  indexStatus: "queued" | "indexing" | "ready" | "partial" | "failed" | null;
  indexProgress: { done: number; total: number } | null;
  indexError: string | null;
  reason: string | null;
};

export type ChatUploads = {
  receipts: ChatUploadReceipt[];
  destinations: { id: string; name: string }[];
  addFiles: (files: File[]) => Promise<void>;
  moveTo: (receiptId: string, bundleId: string) => Promise<void>;
  remove: (receiptId: string) => Promise<void>;
  dismiss: (receiptId: string) => void;
  /**
   * Resolves once no file is still going up or being indexed, or after
   * `timeoutMs` — whichever is first. A question sent while a file is still
   * being indexed would be answered before any passage of it exists.
   */
  settled: (timeoutMs?: number) => Promise<void>;
  /** The file a send is waiting on, while `settled` is waiting; else null. */
  waitingFor: string | null;
};

/** Still going up, or up and not yet searchable. */
export function stillComing(r: Pick<ChatUploadReceipt, "state" | "indexStatus">): boolean {
  return r.state === "uploading" || (r.state === "done" && indexingNow(r));
}

/** Up, and nothing in it can be matched — the job failed, or found no text. */
function notIndexed(r: ChatUploadReceipt): boolean {
  return r.state === "done" && (r.indexStatus === "failed" || (!r.indexStatus && !r.indexed));
}

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
  const { t } = useTranslation();
  const { ensureChatBundle, uploadToBundle, removeDocument, moveDocument, bundles, agents } =
    useAgentsStore();
  const [stored, setReceipts] = useState<ChatUploadReceipt[]>([]);
  const [waiting, setWaiting] = useState(false);

  // What the upload answered is only the start: the job moves on afterwards,
  // and the agents list is where it is seen to. Read during render, not copied
  // into state, so the receipt is never a step behind the knowledge page.
  const liveDocs = agents?.find((a) => a.id === agent.id)?.documents;
  const receipts = stored.map((r): ChatUploadReceipt => {
    const doc = r.documentId ? liveDocs?.find((d) => d.id === r.documentId) : undefined;
    if (!doc) return r;
    const indexStatus = doc.indexStatus ?? null;
    return {
      ...r,
      indexStatus,
      indexProgress: doc.indexProgress ?? null,
      indexError: doc.indexError ?? null,
      indexed: indexStatus
        ? indexStatus === "ready" || indexStatus === "partial"
        : (doc.indexed ?? r.indexed),
    };
  });

  // For `settled`, which is awaited across renders and so cannot close over
  // one render's receipts.
  const latest = useRef(receipts);
  useEffect(() => {
    latest.current = receipts;
  });

  // Said once, when a file turns out not to be searchable — not on upload,
  // when every file is still queued and the warning would be a guess.
  const warned = useRef(new Set<string>());
  useEffect(() => {
    for (const r of receipts) {
      if (!notIndexed(r) || warned.current.has(r.id)) continue;
      warned.current.add(r.id);
      toast.warning(
        t("{{name}} went in but could not be indexed, so answers won't be grounded in it.", {
          name: r.name,
        }),
      );
    }
  });

  const chatBundle = findChatBundle(bundles, agent.id);
  // Anywhere but where the file already is. The chat bundle is the default, so
  // offering it as a destination would be offering to do nothing.
  const destinations = bundles
    .filter((b) => b.id !== chatBundle?.id)
    .map((b) => ({ id: b.id, name: b.name }));
  const nameOf = useCallback(
    (bundleId: string | null) => bundles.find((b) => b.id === bundleId)?.name ?? null,
    [bundles],
  );

  const patch = useCallback((id: string, next: Partial<ChatUploadReceipt>) => {
    setReceipts((prev) => prev.map((r) => (r.id === id ? { ...r, ...next } : r)));
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      const accepted: File[] = [];
      for (const file of files) {
        const check = validateUpload(file, t);
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
            ? t("Couldn't open a place to put the file: {{message}}", { message: e.message })
            : t("Couldn't open a place to put the file."),
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
          bundleId,
          bundleName: nameOf(bundleId),
          state: "uploading" as const,
          progress: 0,
          indexed: false,
          indexStatus: null,
          indexProgress: null,
          indexError: null,
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
              indexStatus: doc.indexStatus ?? null,
              indexProgress: doc.indexProgress ?? null,
              indexError: doc.indexError ?? null,
            });
          } catch (e) {
            patch(id, {
              state: "failed",
              reason: e instanceof Error ? e.message : t("Upload failed"),
            });
          }
        }),
      );
    },
    [agent, ensureChatBundle, uploadToBundle, patch, nameOf, t],
  );

  // Promotion: the file turned out to be worth keeping, so it goes where the
  // workspace keeps things. Deliberately offered after the answer rather than
  // asked before the upload — see the note above the chat bundle in
  // `chat-uploads.ts`.
  const moveTo = useCallback(
    async (receiptId: string, bundleId: string) => {
      const receipt = stored.find((r) => r.id === receiptId);
      if (!receipt?.documentId) return;
      try {
        await moveDocument(receipt.documentId, bundleId);
      } catch (e) {
        toast.error(
          e instanceof Error && e.message
            ? t("Couldn't move it: {{message}}", { message: e.message })
            : t("Couldn't move it."),
        );
        return;
      }
      setReceipts((prev) =>
        prev.map((r) =>
          r.id === receiptId ? { ...r, bundleId, bundleName: nameOf(bundleId) } : r,
        ),
      );
    },
    [stored, moveDocument, nameOf, t],
  );

  const dismiss = useCallback((receiptId: string) => {
    setReceipts((prev) => prev.filter((r) => r.id !== receiptId));
  }, []);

  const remove = useCallback(
    async (receiptId: string) => {
      const receipt = stored.find((r) => r.id === receiptId);
      if (receipt?.documentId) {
        try {
          await removeDocument(receipt.documentId);
        } catch (e) {
          toast.error(
            e instanceof Error && e.message
              ? t("Couldn't remove it: {{message}}", { message: e.message })
              : t("Couldn't remove it."),
          );
          return;
        }
      }
      setReceipts((prev) => prev.filter((r) => r.id !== receiptId));
    },
    [stored, removeDocument, t],
  );

  const settled = useCallback(async (timeoutMs = 45_000) => {
    if (!latest.current.some(stillComing)) return;
    setWaiting(true);
    const deadline = Date.now() + timeoutMs;
    try {
      while (latest.current.some(stillComing) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      setWaiting(false);
    }
  }, []);

  const waitingFor = waiting ? (receipts.find(stillComing)?.name ?? null) : null;

  return { receipts, destinations, addFiles, moveTo, remove, dismiss, settled, waitingFor };
}
