import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, ExternalLink, X } from "lucide-react";

import { useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { api } from "@/lib/api-client";
import { Markdown } from "@/components/markdown";
import { Chip } from "@/components/chip";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { parseCsv } from "@/lib/csv-preview";
import { isMarkdownName, saveDocument } from "@/lib/document-export";
import { formatFileSize } from "@/lib/file-size";
import { documentAge } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

/** The extension, lowercased, with no dot. The same read the upload gate makes. */
function extensionOf(name: string): string {
  // i18n-ignore: a file extension, compared against ASCII names.
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

/**
 * How much of a file this will draw.
 *
 * Uploads cap at 100 MB, which is far more prose than a tab can draw, and a
 * hundred thousand rows of CSV — either would lock the tab for seconds and
 * neither would be read. The cap is announced rather than silent, because a
 * preview that quietly stops is a preview that lies about the file.
 */
const MAX_TEXT_CHARS = 200_000;
const MAX_CSV_ROWS = 300;

type Tab = "file" | "indexed";

/**
 * The formats the File tab can draw: a PDF in the browser's viewer, the rest
 * as text. Word, PowerPoint, Excel and the like are zip archives that would
 * render as noise, so for those the dialog opens on what the agent reads.
 */
const DRAWABLE = new Set([
  "pdf",
  "md",
  "markdown",
  "txt",
  "csv",
  "tsv",
  "json",
  "xml",
  "log",
  "html",
  "htm",
]);

/**
 * Past this the File tab does not fetch the file. Uploads may be 100 MB now, and
 * downloading that into a tab to show its first page is not a preview.
 */
const MAX_DRAWN_BYTES = 25 * 1024 * 1024;

/**
 * One document, both ways.
 *
 * The two tabs answer two questions that are easy to confuse and are not the
 * same: **File** is what was uploaded, and **Indexed** is what the agent has of
 * it. They come apart in ways that decide how to read an answer — the text is
 * chunked from the whole document but the stored excerpt stops at 8000
 * characters, so a long file is searchable to its end while only its opening can
 * ground a reply that matched nothing. A screen that showed only the file would
 * imply the agent read all of it; one that showed only the excerpt would look
 * like the file had been truncated. So: both, labelled.
 *
 * The file tab is lazy on purpose. The excerpt is one row and arrives with the
 * dialog; the bytes are a second request against the document store, and most
 * openings of this dialog are somebody checking whether a file is indexed rather
 * than reading it.
 */
export function DocumentPreviewDialog({
  documentId,
  name,
  onClose,
}: {
  documentId: string;
  /** Known before the request resolves, so the dialog has a title immediately. */
  name: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const ext = extensionOf(name);
  const drawable = DRAWABLE.has(ext);
  const [tab, setTab] = useState<Tab>(drawable ? "file" : "indexed");

  const preview = useQuery({
    queryKey: ["document-preview", documentId],
    queryFn: () => api.documents.preview(documentId),
  });

  // The bytes, only once the file tab has actually been looked at.
  const bytes = useQuery({
    queryKey: ["document-bytes", documentId],
    queryFn: () => api.documents.bytes(documentId),
    enabled: tab === "file" && drawable && !!preview.data && preview.data.size <= MAX_DRAWN_BYTES,
    // A document never changes in place — a re-upload is a new row — so what
    // came back is good for as long as the dialog is open, and for the next
    // opening too.
    staleTime: Infinity,
  });

  // The A22 box: a 56px bar with the title, what it is and what can be done
  // with it; the two views of it as tabs; the page white on the well.
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        hideClose
        aria-describedby={undefined}
        className="h-[min(820px,calc(100dvh-4.5rem))] max-w-[960px] gap-0 overflow-hidden p-0"
      >
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-hairline pr-3 pl-5">
          <DialogTitle className="min-w-0 truncate text-lead font-semibold">{name}</DialogTitle>
          <span className="hidden shrink-0 items-center gap-x-2 text-meta text-muted-foreground md:flex">
            {preview.data ? (
              <>
                <span>{formatFileSize(preview.data.size, locale)}</span>
                <span aria-hidden>·</span>
                <AgeLabel createdAt={preview.data.createdAt} />
                <span aria-hidden>·</span>
                {preview.data.indexed ? (
                  <span>
                    {t("{{count}} passage", {
                      count: preview.data.chunkCount,
                      defaultValue_other: "{{count}} passages",
                    })}
                  </span>
                ) : (
                  <Chip>{t("Not indexed")}</Chip>
                )}
              </>
            ) : (
              <span>{t("Loading…")}</span>
            )}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {preview.data?.externalUrl ? (
              <Button variant="secondary" size="sm" asChild>
                <a href={preview.data.externalUrl} target="_blank" rel="noreferrer noopener">
                  <ExternalLink />
                  {t("Source")}
                </a>
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void api.documents.download(documentId, name)}
            >
              <Download />
              {t("Download")}
            </Button>
            {/* A Markdown document — every report and filed summary is one —
                also goes out as the formats people pass around. */}
            {isMarkdownName(name) ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void saveDocument(documentId, name, "docx")}
                >
                  {/* Format names, the same in every language. */}
                  {"Word"}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void saveDocument(documentId, name, "pdf")}
                >
                  {"PDF"}
                </Button>
              </>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Close")}
              className="text-muted-foreground"
              onClick={onClose}
            >
              <X />
            </Button>
          </div>
        </div>

        <div className="flex h-10 shrink-0 items-stretch gap-4 border-b border-hairline px-5">
          <TabButton active={tab === "file"} onClick={() => setTab("file")}>
            {t("File")}
          </TabButton>
          <TabButton active={tab === "indexed"} onClick={() => setTab("indexed")}>
            {t("What the agent reads")}
          </TabButton>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-surface px-3 pt-6 sm:px-6">
          <div className="mx-auto min-h-full w-full max-w-[720px] rounded-t-sm border border-b-0 border-border bg-background px-6 pt-8 pb-10 shadow-xs sm:px-12">
            {tab === "file" ? (
              !drawable ? (
                <Note>
                  {t(
                    "A .{{ext}} file can't be shown here. Download it to open it, or see what the agent reads of it in the next tab.",
                    { ext },
                  )}
                </Note>
              ) : preview.data && preview.data.size > MAX_DRAWN_BYTES ? (
                <Note>
                  {t(
                    "This file is too large to show here. Download it to open it, or see what the agent reads of it in the next tab.",
                  )}
                </Note>
              ) : (
                <FileTab
                  ext={ext}
                  blob={bytes.data?.blob}
                  loading={bytes.isPending}
                  failed={bytes.isError}
                />
              )
            ) : (
              <IndexedTab preview={preview.data} loading={preview.isPending} />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AgeLabel({ createdAt }: { createdAt: number }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const age = documentAge(createdAt, undefined, t, locale);
  return (
    <span className={cn(age.stale && "text-foreground")}>
      {age.stale
        ? t("uploaded {{age}} · worth checking", { age: age.label })
        : t("uploaded {{age}}", { age: age.label })}
    </span>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "-mb-px border-b-2 text-meta font-medium transition-colors",
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** The file as it is: rendered where that means something, plain where it does not. */
function FileTab({
  ext,
  blob,
  loading,
  failed,
}: {
  ext: string;
  blob: Blob | undefined;
  loading: boolean;
  failed: boolean;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [text, setText] = useState<string | null>(null);
  const isPdf = ext === "pdf";

  // A PDF goes to the browser's own viewer through an object URL. Made during
  // render and revoked on the way out rather than set from an effect: the URL is
  // derived from the blob and nothing else, so storing it in state would be a
  // second copy of a fact React already has — and a render that sets state is a
  // render that happens twice.
  //
  // `slice` is what re-types it, and it is not belt-and-braces: a `blob:`
  // document runs in the creating page's origin, and this app's only CSP is
  // `frame-ancestors 'none'` — measured, that does not restrict script in an
  // inherited `blob:` context. So the only type this iframe may ever commit is
  // the one this branch exists for, whatever type the response carried.
  const objectUrl = useMemo(
    () => (blob && isPdf ? URL.createObjectURL(blob.slice(0, blob.size, "application/pdf")) : null),
    [blob, isPdf],
  );
  useEffect(() => {
    if (!objectUrl) return;
    return () => URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  // Decoding is async, so this one has to be an effect. `live` covers the
  // dialog being closed, or another document opened, mid-read.
  useEffect(() => {
    if (!blob || isPdf) return;
    let live = true;
    void blob.text().then((value) => {
      if (live) setText(value);
    });
    return () => {
      live = false;
    };
  }, [blob, isPdf]);

  if (failed) {
    return <Note>{t("Couldn't load the file. It may have been deleted from storage.")}</Note>;
  }
  if (loading || !blob) return <Note>{t("Loading the file…")}</Note>;

  if (isPdf) {
    return objectUrl ? (
      <iframe
        src={objectUrl}
        title={t("Document")}
        className="h-full min-h-[24rem] w-full rounded-lg"
      />
    ) : (
      <Note>{t("Opening…")}</Note>
    );
  }

  if (text === null) return <Note>{t("Reading…")}</Note>;

  const truncated = text.length > MAX_TEXT_CHARS;
  const shown = truncated ? text.slice(0, MAX_TEXT_CHARS) : text;

  return (
    <>
      {ext === "csv" ? (
        <CsvTable text={shown} />
      ) : ext === "md" || ext === "markdown" ? (
        <Markdown content={shown} className="text-base" />
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-meta leading-relaxed">
          {ext === "json" ? prettyJson(shown) : shown}
        </pre>
      )}
      {truncated ? (
        <Note className="mt-4">
          {t(
            "Showing the first {{chars}} characters. Download the file to read the rest — the whole of it was indexed either way.",
            { chars: MAX_TEXT_CHARS.toLocaleString(locale) },
          )}
        </Note>
      ) : null}
    </>
  );
}

/** Reformatted if it parses, left exactly as it is if it does not. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function CsvTable({ text }: { text: string }) {
  const { t } = useTranslation();
  // One row past the cap, so the notice below can tell the difference between a
  // file that ends at the cap and one that was cut by it.
  const rows = useMemo(() => parseCsv(text, MAX_CSV_ROWS + 1), [text]);
  if (rows.length === 0) return <Note>{t("This file has no rows.")}</Note>;

  const cut = rows.length > MAX_CSV_ROWS;
  const [header, ...body] = cut ? rows.slice(0, MAX_CSV_ROWS) : rows;

  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-hairline">
        <table className="w-full border-collapse text-meta">
          <thead>
            <tr className="bg-surface-muted">
              {header.map((cell, i) => (
                <th
                  key={i}
                  className="whitespace-nowrap border-b border-hairline px-3 py-2 text-left font-medium"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r} className="border-b border-hairline last:border-0">
                {header.map((_, cellIndex) => (
                  <td key={cellIndex} className="px-3 py-2 align-top [overflow-wrap:anywhere]">
                    {row[cellIndex] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* The first row is drawn as a header because a spreadsheet almost always
          has one, and saying so is cheaper than being wrong silently. */}
      <Note className="mt-3">
        {cut
          ? t(
              "The first row is shown as the header. Only the first {{rows}} rows are drawn here.",
              { rows: MAX_CSV_ROWS },
            )
          : t("The first row is shown as the header.")}
      </Note>
    </>
  );
}

/** The stored text — what actually grounds a reply when no passage matched. */
function IndexedTab({
  preview,
  loading,
}: {
  preview: import("@/lib/api-client").DocumentPreview | undefined;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  if (loading) return <Note>{t("Loading…")}</Note>;
  if (!preview) return <Note>{t("Couldn't load what was indexed for this document.")}</Note>;

  if (!preview.excerpt) {
    return (
      <Note>
        {t(
          "Nothing was stored for this document. Files with no readable text are refused now, so this is one that went in before that — re-uploading it is the way to give the agent something to read.",
        )}
      </Note>
    );
  }

  return (
    <>
      <p className="mb-3 text-meta leading-[1.5] text-muted-foreground">
        {preview.indexed
          ? t(
              "Cut into {{count}} passage, each of which retrieval can match on its own. The text below is what grounds an answer when no passage matches the question.",
              {
                count: preview.chunkCount,
                defaultValue_other:
                  "Cut into {{count}} passages, each of which retrieval can match on its own. The text below is what grounds an answer when no passage matches the question.",
              },
            )
          : t(
              "No passages, so nothing in this document can be matched to a question. The text is stored and still grounds an answer when nothing else matches — reindexing is what makes it searchable.",
            )}
      </p>
      <pre className="whitespace-pre-wrap break-words rounded-lg border border-hairline bg-surface p-4 font-mono text-meta leading-relaxed">
        {preview.excerpt}
      </pre>
      <Note className="mt-3">
        {preview.excerptTruncated
          ? t(
              "The stored text stops at {{chars}} characters. The passages above were cut from the whole document, so the rest of the file is still searchable — it just cannot be read back here.",
              { chars: preview.excerptLimit.toLocaleString(locale) },
            )
          : t("This is the whole of the document's text.")}
      </Note>
    </>
  );
}

function Note({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("text-meta leading-[1.5] text-muted-foreground", className)}>{children}</p>
  );
}
