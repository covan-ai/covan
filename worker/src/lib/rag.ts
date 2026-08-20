export type RetrievedChunk = { documentName: string; content: string };

const HEADER =
  "The team has shared the following knowledge. Use it to ground your answers. " +
  "Answer naturally in your own words — do not cite, quote, or mention the document " +
  "names, filenames, or that these documents were provided; the interface shows " +
  "sources separately:\n\n";

/**
 * Assembles retrieved chunks into a system-prompt context block under a total
 * char budget. Chunks are added newest-relevance-first (caller passes them in
 * similarity order); once the budget is exhausted, remaining chunks are dropped.
 * Returns "" when there is nothing to add (caller then skips the block).
 */
export function buildContextBlock(chunks: RetrievedChunk[], budget = 4000): string {
  if (chunks.length === 0) return "";
  let remaining = budget;
  const blocks: string[] = [];
  for (const ch of chunks) {
    if (remaining <= 0) break;
    const body = ch.content.slice(0, remaining);
    remaining -= body.length;
    blocks.push(`Document: ${ch.documentName}\n${body}`);
  }
  if (blocks.length === 0) return "";
  return HEADER + blocks.join("\n\n---\n\n");
}
