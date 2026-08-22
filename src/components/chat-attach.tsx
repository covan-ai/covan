import { useRef, useState } from "react";
import { ChevronDown, FileText, Paperclip, X } from "lucide-react";
import { Chip } from "@/components/section-card";
import { ALLOWED_EXT } from "@/lib/uploads";
import type { ChatUploads } from "@/lib/use-chat-uploads";
import { cn } from "@/lib/utils";

const ACCEPT = ALLOWED_EXT.map((e) => `.${e}`).join(",");

/**
 * The attach control in the chat composer.
 *
 * Hidden entirely from a viewer rather than disabled. Uploading is a write to
 * what the workspace shares and `can_write_in_workspace` refuses it, so the
 * control would be a promise the database breaks — the same reasoning that
 * replaces the Knowledge tab's upload section with a sentence.
 *
 * Split from `ChatReceipts` because the two sit in different parts of the
 * composer: the button belongs on the bottom row beside send, the receipts
 * belong above the text being typed.
 */
export function ChatAttach({ uploads, canWrite }: { uploads: ChatUploads; canWrite: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);

  if (!canWrite) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="grid h-7 w-7 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="Attach a document"
      >
        <Paperclip className="h-4 w-4" />
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        aria-label="Choose documents to attach"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // Reset first: picking the same file twice in a row must still fire.
          e.target.value = "";
          if (files.length > 0) void uploads.addFiles(files);
        }}
      />
    </>
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
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  if (uploads.receipts.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-3 pb-1 pt-2.5">
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
            <span className="tabular-nums text-muted-foreground">{r.progress}%</span>
          )}
          {r.state === "done" &&
            (r.indexed ? (
              <Chip tone="on">Indexed</Chip>
            ) : (
              <span title="No embeddings, so no passage in it can be matched in chat.">
                <Chip tone="neutral">Not indexed</Chip>
              </span>
            ))}
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
                    aria-label={`Move ${r.name} to another bundle`}
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
                <span className="max-w-[12rem] truncate text-muted-foreground">{r.bundleName}</span>
              )}
            </span>
          )}

          <button
            type="button"
            onClick={() =>
              r.state === "failed" ? uploads.dismiss(r.id) : void uploads.remove(r.id)
            }
            className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
            aria-label={`Remove ${r.name}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
