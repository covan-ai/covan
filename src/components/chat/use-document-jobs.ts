import { useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DocumentJob } from "@/lib/api-client";

/**
 * The documents being written in a conversation — the poll, and the rules
 * over it. The browser panel's shape (`use-conversation-browser.ts`): one
 * query under one key, asked every few seconds while something is being
 * written and not at all otherwise.
 *
 * The poll is also a clock. On a deployment with no document host, each ask
 * is what moves the document on by a section (`worker/src/routes/document-jobs.ts`),
 * so a tab left open finishes its document without anything else running.
 */

export const POLL_MS = 3_000;

export const documentJobsKey = (sessionId: string | undefined) =>
  ["document-jobs", sessionId] as const;

/** Still being written: worth asking about again. */
export function isWriting(job: DocumentJob): boolean {
  return job.status === "queued" || job.status === "writing" || job.status === "filing";
}

/** Where a document is, in one line, for the card and the panel. */
export function statusLine(job: DocumentJob): string {
  switch (job.status) {
    case "queued":
      return "Planning the sections…";
    case "writing":
      return `Writing — ${job.written} of ${job.total} sections`;
    case "filing":
      return "Filing it in the reports bundle…";
    case "ready":
      return job.total > 0 ? `Ready — ${job.total} sections` : "Ready";
    case "stopped":
      return `Stopped at ${job.written} of ${job.total} sections`;
    case "failed":
      return job.error ?? "This document could not be finished.";
  }
}

export function shouldPoll(jobs: DocumentJob[] | undefined): boolean {
  return (jobs ?? []).some(isWriting);
}

export function useDocumentJobs(sessionId: string | undefined) {
  const queryClient = useQueryClient();
  // The jobs that were still being written at the last ask, so the ask that
  // sees one finish can refresh the lists the finished document appears in.
  const writing = useRef(new Set<string>());

  return useQuery({
    queryKey: documentJobsKey(sessionId),
    queryFn: async (): Promise<DocumentJob[]> => {
      const jobs = await api.sessions.documentJobs(sessionId!);
      const finished = jobs.some((j) => j.status === "ready" && writing.current.has(j.id));
      writing.current = new Set(jobs.filter(isWriting).map((j) => j.id));
      if (finished) {
        // Bundle counts, the agent's document list, and the explorer — the
        // same three an upload refreshes.
        void queryClient.invalidateQueries({ queryKey: ["bundles"] });
        void queryClient.invalidateQueries({ queryKey: ["agents"] });
        void queryClient.invalidateQueries({ queryKey: ["bundle-documents"] });
      }
      return jobs;
    },
    enabled: !!sessionId,
    refetchInterval: (query) => (shouldPoll(query.state.data) ? POLL_MS : false),
  });
}

/**
 * Which assistant message each job's card sits under.
 *
 * Where it was asked from decides it. The agent's `write_document` is asked in
 * a turn whose reply is written when the turn ends, after the job — so its card
 * goes under the first reply written at or after the job: the one that said
 * "I'm writing it". The Report button is not a turn and has no reply of its
 * own; it writes up what was said before it, so its card goes under the last
 * reply written before the job. Hanging it on the next reply instead put it
 * under an answer to some later, unrelated question.
 *
 * A job with nowhere to go — a tool job whose turn is still running — waits
 * at the foot of the conversation.
 */
export function placeJobs(
  jobs: DocumentJob[],
  messages: Array<{ id: string; role: string; createdAt: number }>,
): { byMessage: Map<string, DocumentJob[]>; trailing: DocumentJob[] } {
  const byMessage = new Map<string, DocumentJob[]>();
  const trailing: DocumentJob[] = [];
  const replies = messages
    .filter((m) => m.role === "assistant")
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);
  // Oldest first, so cards under one message read in the order they started.
  const ordered = jobs.slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const job of ordered) {
    const at = Date.parse(job.createdAt);
    const reply =
      job.origin === "button"
        ? replies.filter((m) => m.createdAt <= at).pop()
        : replies.find((m) => m.createdAt >= at);
    if (!reply) trailing.push(job);
    else byMessage.set(reply.id, [...(byMessage.get(reply.id) ?? []), job]);
  }
  return { byMessage, trailing };
}
