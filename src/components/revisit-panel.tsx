import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";

import { api } from "@/lib/api-client";
import {
  documentsWorthRevisiting,
  countedSince,
  type CountedDocument,
} from "@/lib/stale-documents";
import { STALE_AFTER_DAYS } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

/**
 * The documents this agent reads that are old enough to doubt and used enough
 * to matter, worst first.
 *
 * The source chip already puts an age under an answer, which catches the
 * problem one reply at a time and only for whoever is reading. This is the
 * other half: the question "which of our documents is quietly wrong in the most
 * places" cannot be answered one chip at a time.
 *
 * Renders nothing when there is nothing — no heading, no empty state, no "0
 * documents need attention". A panel that is always there stops being read, and
 * this one is worth reading on the days it appears.
 *
 * The counts come from every conversation in the workspace including the
 * private ones, which is the only way the number means "how much does this team
 * lean on it" rather than "how much do *I*". Nothing but the number crosses:
 * not who asked, not what they asked. See 0038.
 */
export function RevisitPanel({
  documents,
  className,
}: {
  documents: CountedDocument[];
  className?: string;
}) {
  const { data } = useQuery({
    queryKey: ["bundle-citations"],
    queryFn: () => api.bundles.citations(),
    // The answer changes as conversations happen, not as this tab is opened,
    // and nothing here is urgent enough to refetch on every focus.
    staleTime: 5 * 60_000,
  });

  if (!data) return null;

  const worst = documentsWorthRevisiting(documents, data.counts);
  if (worst.length === 0) return null;

  const window = countedSince(data.since);

  return (
    <div
      className={cn(
        "rounded-xl border border-amber-500/40 bg-amber-500/5 px-5 py-4 text-sm",
        className,
      )}
    >
      <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
        <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
        Worth revisiting
      </div>
      <p className="mt-1 text-xs leading-[1.5] text-muted-foreground">
        Older than {STALE_AFTER_DAYS} days, and answers are still being built on them.
      </p>
      <ul className="mt-3 space-y-1.5">
        {worst.map((doc) => (
          <li key={doc.id} className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate">{doc.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{doc.age}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {doc.citations} {doc.citations === 1 ? "answer" : "answers"}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 border-t border-amber-500/20 pt-2.5 text-xs leading-[1.5] text-muted-foreground">
        {/* Both halves of the caveat, because a number invites more trust than
            it has earned. A citation means the document was searched and
            admitted, not that a word of it reached the model — the context
            budget cuts documents that are still cited (docs/knowledge.md). And
            the count starts where citations started carrying ids, not at the
            beginning of the workspace. */}
        A count of answers that cited a document, not of answers it changed.
        {window ? ` ${window}` : null}
      </p>
    </div>
  );
}
