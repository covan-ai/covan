import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Chip } from "@/components/chip";
import { DataTable } from "@/components/data-table";
import { SectionLabel } from "@/components/section";
import { Button } from "@/components/ui/button";
import { api, ApiError, type CreditLedgerEntry } from "@/lib/api-client";
import { useIsHosted } from "@/lib/credits";
import { ledgerWhen } from "@/lib/day-groups";

/** How each kind of row reads when nothing names what it was for. */
const KIND: Record<CreditLedgerEntry["kind"], string> = {
  signup_grant: "Free credits",
  grant: "Credits added",
  purchase: "Bought credits",
  refund: "Refund",
  completion: "Model",
  embedding: "Indexing and search",
  transcription: "Dictation",
  composio_call: "Connected app",
  composio_search: "Connected app search",
  browser_task: "Browser task",
  browser_session: "Browser session",
};

/** Why a completion happened, when the row says. */
const PURPOSE: Record<string, string> = {
  reply: "Reply",
  title: "Thread title",
  follow_ups: "Suggested questions",
  persona: "Persona draft",
  brainstorm: "Brainstorm",
  routine_draft: "Routine draft",
  routine: "Routine run",
  report: "Report",
  summary: "Summary",
  coverage: "Coverage report",
  slack: "Slack answer",
  reading: "Reading connected-app results",
};

/** "Bought 10,000 credits", "Persona draft", the note a grant was written with. */
function what(e: CreditLedgerEntry): string {
  if (e.kind === "purchase")
    return `Bought ${Math.round(e.credits).toLocaleString("en-US")} credits`;
  if ((e.kind === "grant" || e.kind === "signup_grant") && e.note) return e.note;
  if (e.kind === "completion" && e.purpose && PURPOSE[e.purpose]) return PURPOSE[e.purpose];
  return KIND[e.kind] ?? e.kind;
}

/** Two decimals under one credit, whole credits above — a credit is the unit, not a rounding. */
function amount(v: number): string {
  const abs = Math.abs(v);
  const shown =
    abs >= 100
      ? Math.round(abs).toLocaleString("en-US")
      : abs >= 1
        ? abs.toFixed(1).replace(/\.0$/, "")
        : abs.toFixed(2);
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${shown === "0.00" ? "<0.01" : shown}`;
}

function Entry({ e }: { e: CreditLedgerEntry }) {
  const why = e.kind === "completion" && e.purpose && e.purpose !== "reply" ? what(e) : null;
  const suffix = why ? <span className="text-muted-foreground"> · {why}</span> : null;
  if (e.routineId && e.routineName) {
    return (
      <span>
        <Link
          to="/routines/$routineId"
          params={{ routineId: e.routineId }}
          className="underline-offset-4 hover:underline"
        >
          {e.routineName}
        </Link>
        {suffix}
      </span>
    );
  }
  if (e.sessionTitle && e.sessionId && e.agentId) {
    return (
      <span>
        <Link
          to="/agents/$agentId/chat"
          params={{ agentId: e.agentId }}
          search={{ s: e.sessionId }}
          className="underline-offset-4 hover:underline"
        >
          {e.sessionTitle}
        </Link>
        {suffix}
      </span>
    );
  }
  // Somebody's private thread: its cost is the workspace's, its title is not.
  if (e.sessionId && !e.sessionTitle) {
    return (
      <span>
        A private thread<span className="text-muted-foreground"> · {what(e)}</span>
      </span>
    );
  }
  return <span>{what(e)}</span>;
}

const firstName = (name: string) => name.split(/\s+/)[0] || name;

/**
 * Settings › Usage and billing › Ledger (A15): every charge and grant, newest
 * first, with what it was for — the thread or routine, its agent, who started
 * it — for an admin. Older rows a page at a time; the whole of it as CSV.
 *
 * Hosted only. A self-hosted install keeps no ledger, and this renders nothing
 * there rather than an empty table about a feature that does not exist.
 */
export function CreditLedger() {
  const hosted = useIsHosted();
  const [exporting, setExporting] = useState(false);
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ["usage", "credit-ledger"],
    queryFn: ({ pageParam }) => api.creditLedger({ limit: 50, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.entries.at(-1)?.id : undefined),
    enabled: hosted === true,
  });

  if (hosted !== true) return null;
  const entries = data?.pages.flatMap((p) => p.entries) ?? [];

  const exportCsv = async () => {
    setExporting(true);
    try {
      await api.creditLedgerCsv();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't export the ledger");
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="mt-10">
      <SectionLabel
        action={
          <button
            type="button"
            onClick={() => void exportCsv()}
            disabled={exporting || entries.length === 0}
            className="text-meta font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
        }
      >
        Ledger
      </SectionLabel>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="overflow-x-auto">
          <DataTable
            label="Credit ledger"
            rows={entries}
            rowKey={(e) => String(e.id)}
            empty={
              <p className="text-sm text-muted-foreground">
                Every charge and every purchase shows up here as it happens.
              </p>
            }
            columns={[
              {
                key: "when",
                header: "When",
                className: "whitespace-nowrap",
                cell: (e) => (
                  <span className="text-muted-foreground">{ledgerWhen(Date.parse(e.at))}</span>
                ),
              },
              { key: "entry", header: "Entry", cell: (e) => <Entry e={e} /> },
              {
                key: "agent",
                header: "Agent",
                hideBelow: "md",
                cell: (e) =>
                  e.agentName ? (
                    <Chip>{e.agentName}</Chip>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  ),
              },
              {
                key: "by",
                header: "By",
                hideBelow: "md",
                cell: (e) => (
                  <span className="text-muted-foreground">
                    {e.by?.kind === "routine"
                      ? "Routine"
                      : e.by?.kind === "person"
                        ? firstName(e.by.name)
                        : "—"}
                  </span>
                ),
              },
              {
                key: "credits",
                header: "Credits",
                num: true,
                cell: (e) => (
                  <span className={e.credits > 0 ? "font-medium" : undefined}>
                    {amount(e.credits)}
                  </span>
                ),
              },
            ]}
          />
        </div>
      )}
      {hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          {isFetchingNextPage ? "Loading…" : "Show older"}
        </Button>
      )}
      <p className="mt-3 text-meta text-muted-foreground">
        A browser session appears twice: a hold when it starts, and the difference once the provider
        says what it really cost. A private thread&rsquo;s cost is listed; its title is not.
      </p>
    </section>
  );
}
