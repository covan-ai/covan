import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, ExternalLink, FileText } from "lucide-react";

import { api } from "@/lib/api-client";
import { Markdown } from "@/components/markdown";
import { Chip } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { parseCsv } from "@/lib/csv-preview";
import { formatFileSize } from "@/lib/file-size";
import { documentAge } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

/** The extension, lowercased, with no dot. The same read the upload gate makes. */
function extensionOf(name: string): string {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

/**
 * How much of a file this will draw.
 *
 * Uploads cap at 10 MB, which is about two million characters of prose and a
 * hundred thousand rows of CSV — either would lock the tab for seconds and
 * neither would be read. The cap is announced rather than silent, because a
 * preview that quietly stops is a preview that lies about the file.
 */
const MAX_TEXT_CHARS = 200_000;
const MAX_CSV_ROWS = 300;

type Tab = "file" | "indexed";

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
  const [tab, setTab] = useState<Tab>("file");
  const ext = extensionOf(name);

  const preview = useQuery({
    queryKey: ["document-preview", documentId],
    queryFn: () => api.documents.preview(documentId),
  });

  // The bytes, only once the file tab has actually been looked at.
  const bytes = useQuery({
    queryKey: ["document-bytes", documentId],
    queryFn: () => api.documents.bytes(documentId),
    enabled: tab === "file",
    // A document never changes in place — a re-upload is a new row — so what
    // came back is good for as long as the dialog is open, and for the next
    // opening too.
    staleTime: Infinity,
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(85vh,52rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <div className="flex items-start gap-3 border-b border-hairline px-5 py-4 pr-12">
          <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-[17px]">{name}</DialogTitle>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {preview.data ? (
                <>
                  <span>{formatFileSize(preview.data.size)}</span>
                  <span aria-hidden>·</span>
                  <AgeLabel createdAt={preview.data.createdAt} />
                  <span aria-hidden>·</span>
                  {preview.data.indexed ? (
                    <span>
                      {preview.data.chunkCount}{" "}
                      {preview.data.chunkCount === 1 ? "passage" : "passages"}
                    </span>
                  ) : (
                    <Chip tone="neutral">Not indexed</Chip>
                  )}
                </>
              ) : (
                <span>Loading…</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 border-b border-hairline px-5 py-2">
          <TabButton active={tab === "file"} onClick={() => setTab("file")}>
            File
          </TabButton>
          <TabButton active={tab === "indexed"} onClick={() => setTab("indexed")}>
            What the agent reads
          </TabButton>
          <div className="ml-auto flex items-center gap-1">
            {preview.data?.externalUrl ? (
              <Button variant="ghost" size="sm" asChild>
                <a href={preview.data.externalUrl} target="_blank" rel="noreferrer noopener">
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  Source
                </a>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void api.documents.download(documentId, name)}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Download
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {tab === "file" ? (
            <FileTab
              ext={ext}
              blob={bytes.data?.blob}
              loading={bytes.isPending}
              failed={bytes.isError}
            />
          ) : (
            <IndexedTab preview={preview.data} loading={preview.isPending} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AgeLabel({ createdAt }: { createdAt: number }) {
  const age = documentAge(createdAt);
  return (
    <span className={cn(age.stale && "text-amber-700 dark:text-amber-400")}>
      uploaded {age.label}
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
        "rounded-sm px-2.5 py-1 text-[13px] font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
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
  const [text, setText] = useState<string | null>(null);
  const isPdf = ext === "pdf";

  // A PDF goes to the browser's own viewer through an object URL. Made during
  // render and revoked on the way out rather than set from an effect: the URL is
  // derived from the blob and nothing else, so storing it in state would be a
  // second copy of a fact React already has — and a render that sets state is a
  // render that happens twice.
  const objectUrl = useMemo(
    () => (blob && isPdf ? URL.createObjectURL(blob) : null),
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
    return <Note>Couldn't load the file. It may have been deleted from storage.</Note>;
  }
  if (loading || !blob) return <Note>Loading the file…</Note>;

  if (isPdf) {
    return objectUrl ? (
      <iframe src={objectUrl} title="Document" className="h-full min-h-[24rem] w-full rounded-lg" />
    ) : (
      <Note>Opening…</Note>
    );
  }

  if (text === null) return <Note>Reading…</Note>;

  const truncated = text.length > MAX_TEXT_CHARS;
  const shown = truncated ? text.slice(0, MAX_TEXT_CHARS) : text;

  return (
    <>
      {ext === "csv" ? (
        <CsvTable text={shown} />
      ) : ext === "md" || ext === "markdown" ? (
        <Markdown content={shown} />
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed">
          {ext === "json" ? prettyJson(shown) : shown}
        </pre>
      )}
      {truncated ? (
        <Note className="mt-4">
          Showing the first {MAX_TEXT_CHARS.toLocaleString("en")} characters. Download the file to
          read the rest — the whole of it was indexed either way.
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
  // One row past the cap, so the notice below can tell the difference between a
  // file that ends at the cap and one that was cut by it.
  const rows = useMemo(() => parseCsv(text, MAX_CSV_ROWS + 1), [text]);
  if (rows.length === 0) return <Note>This file has no rows.</Note>;

  const cut = rows.length > MAX_CSV_ROWS;
  const [header, ...body] = cut ? rows.slice(0, MAX_CSV_ROWS) : rows;

  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-hairline">
        <table className="w-full border-collapse text-[13px]">
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
        The first row is shown as the header.
        {cut ? ` Only the first ${MAX_CSV_ROWS} rows are drawn here.` : ""}
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
  if (loading) return <Note>Loading…</Note>;
  if (!preview) return <Note>Couldn't load what was indexed for this document.</Note>;

  if (!preview.excerpt) {
    return (
      <Note>
        Nothing was stored for this document. Files with no readable text are refused now, so this
        is one that went in before that — re-uploading it is the way to give the agent something to
        read.
      </Note>
    );
  }

  return (
    <>
      <p className="mb-3 text-[13px] leading-[1.5] text-muted-foreground">
        {preview.indexed ? (
          <>
            Cut into {preview.chunkCount} {preview.chunkCount === 1 ? "passage" : "passages"}, each
            of which retrieval can match on its own. The text below is what grounds an answer when
            no passage matches the question.
          </>
        ) : (
          <>
            No passages, so nothing in this document can be matched to a question. The text is
            stored and still grounds an answer when nothing else matches — reindexing is what makes
            it searchable.
          </>
        )}
      </p>
      <pre className="whitespace-pre-wrap break-words rounded-lg border border-hairline bg-surface p-4 font-mono text-[13px] leading-relaxed">
        {preview.excerpt}
      </pre>
      <Note className="mt-3">
        {preview.excerptTruncated
          ? `The stored text stops at ${preview.excerptLimit.toLocaleString("en")} characters. The passages above were cut from the whole document, so the rest of the file is still searchable — it just cannot be read back here.`
          : "This is the whole of the document's text."}
      </Note>
    </>
  );
}

function Note({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("text-[13px] leading-[1.5] text-muted-foreground", className)}>{children}</p>
  );
}
