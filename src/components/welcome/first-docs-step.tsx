import { useRef, useState, type DragEvent } from "react";
import { Link } from "@tanstack/react-router";
import { Upload } from "lucide-react";
import { toast } from "sonner";
import { lookup, msg, useTranslation } from "@/i18n";
import { Chip } from "@/components/chip";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { formatFileSize } from "@/lib/file-size";
import { KNOWLEDGE_TEMPLATES, type KnowledgeTemplate } from "@/lib/knowledge-templates";
import { useAgentsStore, type Agent } from "@/lib/agents-store";
import { ACCEPT, ACCEPTED_SUMMARY, validateUpload } from "@/lib/uploads";
import { cn } from "@/lib/utils";

/**
 * The four kinds of file most teams already have (A29). `title` and `line`
 * are English keys; `kind` is the file-type badge, not a word.
 */
const KINDS = [
  {
    id: "policies",
    kind: "PDF",
    title: msg("Policies or a handbook"),
    line: msg("Refunds, shipping, what you promise. The thing people ask about most."),
  },
  {
    id: "product",
    kind: "DOC",
    title: msg("Product docs or a price list"),
    line: msg("What you sell, in your words, with the numbers."),
  },
  {
    id: "templates",
    kind: "TXT",
    title: msg("Reply templates or macros"),
    line: msg("The answers your team already copies and pastes."),
  },
  {
    id: "faq",
    kind: "MD",
    title: msg("FAQ"),
    line: msg("The questions that keep coming back, answered once."),
  },
] as const;

const TEMPLATES = ["faq.md", "how-we-work.md", "product-notes.md"]
  .map((f) => KNOWLEDGE_TEMPLATES.find((tpl) => tpl.filename === f))
  .filter((tpl): tpl is KnowledgeTemplate => Boolean(tpl));

type Uploaded = { name: string; size: number };

/**
 * "What should Support know?" (A29): the first documents, after the agent
 * exists. Four cards for the files most teams already have, a well that takes
 * anything dropped on it, a way to connect Drive instead, and three templates
 * for a team with nothing written down. Every file goes into one folder made
 * for the agent on the first upload, and the agent reads it at once.
 */
export function FirstDocsStep({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { createBundle, attachBundle, uploadToBundle } = useAgentsStore();
  const [folderId, setFolderId] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<Record<string, Uploaded>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const pickingFor = useRef<string>("any");

  const folder = async (): Promise<string> => {
    if (folderId) return folderId;
    const bundle = await createBundle(t("{{agent}}'s documents", { agent: agent.name }));
    await attachBundle(agent.id, bundle.id);
    setFolderId(bundle.id);
    return bundle.id;
  };

  const upload = async (files: FileList | File[] | null, slot: string) => {
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    setBusy(slot);
    try {
      const id = await folder();
      for (const file of list) {
        const check = validateUpload(file);
        if (!check.ok) {
          toast.error(check.reason);
          continue;
        }
        await uploadToBundle(id, file);
        setUploaded((prev) => ({
          ...prev,
          [slot === "any" ? `any:${file.name}` : slot]: { name: file.name, size: file.size },
        }));
      }
    } catch {
      toast.error(t("Couldn't upload that. Try again, or add it later in Knowledge."));
    } finally {
      setBusy(null);
    }
  };

  const pick = (slot: string) => {
    pickingFor.current = slot;
    picker.current?.click();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void upload(e.dataTransfer.files, "any");
  };

  const loose = Object.entries(uploaded).filter(([k]) => k.startsWith("any:"));

  return (
    <div>
      <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
        {KINDS.map((k) => {
          const done = uploaded[k.id];
          return (
            <li
              key={k.id}
              className={cn(
                "flex items-start gap-3 rounded-[10px] border p-3.5",
                done ? "border-foreground" : "border-border",
              )}
            >
              <span
                className={cn(
                  "grid h-9 w-9 shrink-0 place-items-center rounded-md text-xs font-semibold",
                  done ? "bg-foreground text-background" : "bg-surface text-chip-foreground",
                )}
              >
                {k.kind}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{lookup(t, k.title)}</span>
                <span className="block text-meta text-muted-foreground">
                  {done
                    ? t("Uploaded · {{name}} · {{size}}", {
                        name: done.name,
                        size: formatFileSize(done.size),
                      })
                    : lookup(t, k.line)}
                </span>
              </span>
              {done ? (
                <StatusDot state="done" className="mt-3" />
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => pick(k.id)}
                  aria-label={t("Upload {{kind}}", { kind: lookup(t, k.title) })}
                >
                  {busy === k.id ? t("Uploading…") : t("Upload")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "mt-6 flex flex-wrap items-center gap-3 rounded-[10px] border border-dashed px-4 py-3.5",
          dragging ? "border-foreground bg-surface-muted" : "border-dot-done",
        )}
      >
        <Upload className="size-4 text-muted-foreground" aria-hidden />
        <button
          type="button"
          onClick={() => pick("any")}
          className="min-w-0 flex-1 text-left text-sm"
        >
          <span className="font-medium">
            {busy === "any" ? t("Uploading…") : t("Or drop anything here.")}
          </span>{" "}
          <span className="text-muted-foreground">{ACCEPTED_SUMMARY}.</span>
        </button>
        <Button size="sm" variant="secondary" asChild>
          <Link to="/settings/integrations">{t("Connect Google Drive")}</Link>
        </Button>
      </div>
      {loose.length > 0 ? (
        <p className="mt-2 mb-0 text-meta text-muted-foreground">
          {t("Also uploaded: {{names}}", { names: loose.map(([, f]) => f.name).join(", ") })}
        </p>
      ) : null}

      <input
        ref={picker}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        aria-label={t("Choose files")}
        onChange={(e) => {
          void upload(e.target.files, pickingFor.current);
          e.target.value = "";
        }}
      />

      <div className="mt-6">
        <div className="text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase">
          {t("Nothing written down yet?")}
        </div>
        <p className="mt-1 mb-1.5 text-meta text-muted-foreground">
          {t(
            "Fill in a template and upload it. Each is a page with the headings a good document has.",
          )}
        </p>
        <ul className="m-0 list-none p-0">
          {TEMPLATES.map((tpl) => (
            <li
              key={tpl.filename}
              className="flex min-h-11 items-center gap-3 border-b border-hairline last:border-b-0"
            >
              <Chip tone="code">{tpl.filename}</Chip>
              <span className="min-w-0 flex-1 truncate text-sm">{tpl.blurb}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => downloadTemplate(tpl)}
                aria-label={t("Download {{file}}", { file: tpl.filename })}
              >
                {t("Download")}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function downloadTemplate(template: KnowledgeTemplate): void {
  const url = URL.createObjectURL(
    new Blob([template.body], { type: "text/markdown;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = template.filename;
  link.click();
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}
