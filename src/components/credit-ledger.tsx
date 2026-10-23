import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { lookup, msg, useTranslation, type TFunction } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { Chip } from "@/components/chip";
import { DataTable } from "@/components/data-table";
import { SectionLabel } from "@/components/section";
import { Button } from "@/components/ui/button";
import { api, ApiError, type CreditLedgerEntry } from "@/lib/api-client";
import { useIsHosted } from "@/lib/credits";
import { ledgerWhen } from "@/lib/day-groups";

/** How each kind of row reads when nothing names what it was for. */
const KIND: Record<CreditLedgerEntry["kind"], string> = {
  signup_grant: msg("Free credits"),
  grant: msg("Credits added"),
  purchase: msg("Bought credits"),
  refund: msg("Refund"),
  completion: msg("Model"),
  embedding: msg("Indexing and search"),
  transcription: msg("Dictation"),
  composio_call: msg("Connected app"),
  composio_search: msg("Connected app search"),
  browser_task: msg("Browser task"),
  browser_session: msg("Browser session"),
};

/** Why a completion happened, when the row says. */
const PURPOSE: Record<string, string> = {
  reply: msg("Reply"),
  title: msg("Thread title"),
  follow_ups: msg("Suggested questions"),
  persona: msg("Persona draft"),
  brainstorm: msg("Brainstorm"),
  routine_draft: msg("Routine draft"),
  routine: msg("Routine run"),
  report: msg("Report"),
  summary: msg("Summary"),
  coverage: msg("Coverage report"),
  slack: msg("Slack answer"),
  reading: msg("Reading connected-app results"),
};

/**
 * "Bought 10,000 credits", "Persona draft", the note a grant was written with.
 * The note is the server's own words and is shown as written.
 */
function what(e: CreditLedgerEntry, t: TFunction, locale: string): string {
  if (e.kind === "purchase") {
    const whole = Math.round(e.credits);
    return t("Bought {{credits}} credit", {
      count: whole,
      credits: whole.toLocaleString(locale),
      defaultValue_other: "Bought {{credits}} credits",
    });
  }
  if ((e.kind === "grant" || e.kind === "signup_grant") && e.note) return e.note;
  if (e.kind === "completion" && e.purpose && PURPOSE[e.purpose]) {
    return lookup(t, PURPOSE[e.purpose]);
  }
  const kind = KIND[e.kind];
  return kind ? lookup(t, kind) : e.kind;
}

/** Two decimals under one credit, whole credits above — a credit is the unit, not a rounding. */
function amount(v: number, locale: string): string {
  const abs = Math.abs(v);
  const shown =
    abs >= 100
      ? Math.round(abs).toLocaleString(locale)
      : abs >= 1
        ? abs.toLocaleString(locale, { maximumFractionDigits: 1 })
        : abs < 0.005
          ? `<${(0.01).toLocaleString(locale, { minimumFractionDigits: 2 })}`
          : abs.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${shown}`;
}

function Entry({ e }: { e: CreditLedgerEntry }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const why =
    e.kind === "completion" && e.purpose && e.purpose !== "reply" ? what(e, t, locale) : null;
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
        {t("A private thread")}
        <span className="text-muted-foreground"> · {what(e, t, locale)}</span>
      </span>
    );
  }
  return <span>{what(e, t, locale)}</span>;
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
  const { t } = useTranslation();
  const locale = useLocale();
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
      toast.error(e instanceof ApiError ? e.message : t("Couldn't export the ledger"));
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
            {exporting ? t("Exporting…") : t("Export CSV")}
          </button>
        }
      >
        {t("Ledger")}
      </SectionLabel>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
      ) : (
        <div className="overflow-x-auto">
          <DataTable
            label={t("Credit ledger")}
            rows={entries}
            rowKey={(e) => String(e.id)}
            empty={
              <p className="text-sm text-muted-foreground">
                {t("Every charge and every purchase shows up here as it happens.")}
              </p>
            }
            columns={[
              {
                key: "when",
                header: t("When"),
                className: "whitespace-nowrap",
                cell: (e) => (
                  <span className="text-muted-foreground">
                    {ledgerWhen(Date.parse(e.at), undefined, t, locale)}
                  </span>
                ),
              },
              { key: "entry", header: t("Entry"), cell: (e) => <Entry e={e} /> },
              {
                key: "agent",
                header: t("Agent"),
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
                header: t("By"),
                hideBelow: "md",
                cell: (e) => (
                  <span className="text-muted-foreground">
                    {e.by?.kind === "routine"
                      ? t("Routine")
                      : e.by?.kind === "person"
                        ? firstName(e.by.name)
                        : "—"}
                  </span>
                ),
              },
              {
                key: "credits",
                header: t("Credits"),
                num: true,
                cell: (e) => (
                  <span className={e.credits > 0 ? "font-medium" : undefined}>
                    {amount(e.credits, locale)}
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
          {isFetchingNextPage ? t("Loading…") : t("Show older")}
        </Button>
      )}
      <p className="mt-3 text-meta text-muted-foreground">
        {t(
          "A browser session appears twice: a hold when it starts, and the difference once the provider says what it really cost. A private thread’s cost is listed; its title is not.",
        )}
      </p>
    </section>
  );
}
