import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Markdown } from "@/components/markdown";

/**
 * A Markdown document laid out for paper, printing itself.
 *
 * The PDF fallback (`src/lib/document-export.ts`). Where the server has no
 * browser to print a PDF with — a Docker install, or a Cloudflare deployment
 * without Browser Rendering bound — this page is loaded out of sight and the
 * person's own browser prints it, "Save as PDF" included. It is the same
 * document in the same type as the document panel; `@media print` in
 * `styles.css` puts only `.print-root` on the page.
 *
 * Read through the ordinary download route, so a document the person cannot
 * see is one this page cannot show either.
 */
export const Route = createFileRoute("/_authed/documents/$documentId/print")({
  component: PrintDocument,
  head: () => ({ meta: [{ title: "Print · Covan" }] }),
});

function PrintDocument() {
  const { documentId } = Route.useParams();
  const { data, error } = useQuery({
    queryKey: ["document-print", documentId],
    queryFn: async () => {
      const { blob } = await api.documents.bytes(documentId);
      return blob.text();
    },
    retry: false,
  });
  const [printed, setPrinted] = useState(false);

  // Once, after the document is on the page and has been laid out — a print
  // started a frame earlier would print an empty page.
  useEffect(() => {
    if (!data || printed) return;
    const frame = window.requestAnimationFrame(() => {
      setPrinted(true);
      window.print();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [data, printed]);

  if (error) {
    return (
      <p className="p-6 text-meta text-muted-foreground">This document could not be loaded.</p>
    );
  }
  if (!data) {
    return <p className="p-6 text-meta text-muted-foreground">Preparing the document…</p>;
  }
  return (
    <div className="print-root bg-background">
      <article className="doc-reading mx-auto max-w-2xl px-6 py-8">
        <Markdown content={data} />
      </article>
    </div>
  );
}
