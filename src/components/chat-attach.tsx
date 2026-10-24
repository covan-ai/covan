import { useState, type RefObject } from "react";
import { ChevronDown, FileText, X } from "lucide-react";
import { Chip } from "@/components/chip";
import { ACCEPT } from "@/lib/uploads";
import type { ChatUploadReceipt, ChatUploads } from "@/lib/use-chat-uploads";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";

/**
 * The file picker behind the composer's "+ › Attach a file" (A2), and behind
 * the empty thread's "Upload a document": one hidden input, opened by
 * whoever holds its ref.
 *
 * Not drawn at all for a viewer. Uploading is a write to what the workspace
 * shares and `can_write_in_workspace` refuses it, so the picker would be a
 * promise the database breaks.
 */
export function AttachInput({
  uploads,
  canWrite,
  inputRef,
}: {
  uploads: ChatUploads;
  canWrite: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const { t } = useTranslation();
  if (!canWrite) return null;
  return (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept={ACCEPT}
      aria-label={t("Choose documents to attach")}
      className="hidden"
      onChange={(e) => {
        const files = Array.from(e.target.files ?? []);
        // Reset first: picking the same file twice in a row must still fire.
        e.target.value = "";
        if (files.length > 0) void uploads.addFiles(files);
      }}
    />
  );
}

/**
 * What each dropped file became, kept above the composer rather than announced
 * in a toast.
 *
 * Both things a person needs from a chat upload outlive a toast. Whether the
 * file is retrievable at all decides how to read the next answer, and whether
 * it should stay in the agent's knowledge is a decision they can only make
 * after seeing that answer.
 */
export function ChatReceipts({ uploads }: { uploads: ChatUploads }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  if (uploads.receipts.length === 0) return null;

  return (
    <div className="px-3 pb-1 pt-2.5">
      <div className="flex flex-wrap gap-2">
        {uploads.receipts.map((r) => (
          <div
            key={r.id}
            className={cn(
              // rounded-sm to match the composer's other children (the agent chip,
              // the send button) rather than the panel they all sit in.
              "flex max-w-full items-center gap-2 rounded-sm border border-border bg-surface px-2.5 py-1.5 text-xs",
              r.state === "failed" && "border-destructive/40",
            )}
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{r.name}</span>

            {r.state === "uploading" && (
              <span className="tabular-nums text-muted-foreground">
                {new Intl.NumberFormat(locale, { style: "percent" }).format(r.progress / 100)}
              </span>
            )}
            {r.state === "done" && <IndexChip receipt={r} />}
            {r.state === "failed" && <span className="text-destructive">{r.reason}</span>}

            {/* Where it landed, and the offer to put it somewhere better. The
              question the upload could not answer — is this worth keeping? —
              asked here, after the answer that settles it. */}
            {r.state === "done" && r.bundleName && (
              <span className="relative">
                {uploads.destinations.length > 0 ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setOpenMenu((cur) => (cur === r.id ? null : r.id))}
                      className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
                      aria-label={t("Move {{name}} to another bundle", { name: r.name })}
                      aria-expanded={openMenu === r.id}
                    >
                      <span className="max-w-[12rem] truncate">{r.bundleName}</span>
                      <ChevronDown className="h-3 w-3 shrink-0" />
                    </button>
                    {openMenu === r.id && (
                      <div className="absolute bottom-full left-0 z-30 mb-1 max-h-56 min-w-44 overflow-y-auto rounded-sm border border-border bg-popover py-1 shadow-card">
                        {uploads.destinations.map((d) => (
                          <button
                            key={d.id}
                            type="button"
                            onClick={() => {
                              setOpenMenu(null);
                              void uploads.moveTo(r.id, d.id);
                            }}
                            className="block w-full truncate px-3 py-1.5 text-left transition-colors hover:bg-surface-hover"
                          >
                            {d.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <span className="max-w-[12rem] truncate text-muted-foreground">
                    {r.bundleName}
                  </span>
                )}
              </span>
            )}

            <button
              type="button"
              onClick={() =>
                r.state === "failed" ? uploads.dismiss(r.id) : void uploads.remove(r.id)
              }
              className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
              aria-label={t("Remove {{name}}", { name: r.name })}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      {/* A question sent now waits for the file it would be answered from. */}
      {uploads.waitingFor && (
        <p role="status" className="pt-2 text-xs text-muted-foreground">
          {t("Waiting for {{name}} to finish indexing…", { name: uploads.waitingFor })}
        </p>
      )}
    </div>
  );
}

/**
 * Whether the file can be answered from yet. Indexing runs after the upload
 * returns, so a fresh file reads "Indexing…" until the job finishes — "Not
 * indexed" is kept for a job that failed, never for one that has not run.
 */
function IndexChip({ receipt: r }: { receipt: ChatUploadReceipt }) {
  const { t } = useTranslation();
  if (r.indexStatus === "queued" || r.indexStatus === "indexing") {
    const p = r.indexProgress;
    const pct = p && p.total > 0 ? Math.min(99, Math.round((p.done / p.total) * 100)) : null;
    return (
      <span title={t("Waiting to be read and indexed.")}>
        <Chip>{pct === null ? t("Indexing…") : t("Indexing {{pct}}%", { pct })}</Chip>
      </span>
    );
  }
  if (r.indexed) return <Chip>{t("Indexed")}</Chip>;
  return (
    <span title={r.indexError ?? t("No embeddings, so no passage in it can be matched in chat.")}>
      <Chip className="text-destructive">{t("Not indexed")}</Chip>
    </span>
  );
}
