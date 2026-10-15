/**
 * What the browser is told about a document job.
 *
 * Only the columns 0102 grants a client, so the same shape comes back whether
 * the row was read through the caller's client or returned by an insert made
 * with the service role. `history` and `sources` are never in it.
 */

export const JOB_COLUMNS =
  "id, workspace_id, bundle_id, agent_id, session_id, requested_by, origin, instruction, " +
  "title, outline, cursor, status, document_id, error, created_at, updated_at, finished_at";

export type DocumentSectionDto = {
  index: number;
  heading: string;
  body: string;
  done: boolean;
};

export type DocumentJobDto = {
  id: string;
  agentId: string;
  sessionId: string | null;
  bundleId: string;
  origin: "tool" | "button";
  instruction: string;
  title: string;
  status: "queued" | "writing" | "filing" | "ready" | "failed" | "stopped";
  /** Sections done, of how many. Zero of zero until the outline is in. */
  written: number;
  total: number;
  documentId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  sections: DocumentSectionDto[];
};

type JobRow = Record<string, unknown>;
type SectionRow = { idx: number; heading: string; body: string; status: string };

export function mapDocumentJob(row: JobRow, sections: SectionRow[]): DocumentJobDto {
  const outline = Array.isArray(row.outline) ? row.outline : [];
  const ordered = sections.slice().sort((a, b) => a.idx - b.idx);
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    sessionId: (row.session_id as string | null) ?? null,
    bundleId: row.bundle_id as string,
    origin: row.origin as DocumentJobDto["origin"],
    instruction: row.instruction as string,
    title: row.title as string,
    status: row.status as DocumentJobDto["status"],
    written: ordered.filter((s) => s.status === "done").length,
    total: ordered.length || outline.length,
    documentId: (row.document_id as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
    sections: ordered.map((s) => ({
      index: s.idx,
      heading: s.heading,
      body: s.body,
      done: s.status === "done",
    })),
  };
}
