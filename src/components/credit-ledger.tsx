import { useQuery } from "@tanstack/react-query";
import { api, type CreditLedgerEntry } from "@/lib/api-client";
import { useIsHosted } from "@/lib/credits";
import { SectionCard, EmptyState } from "@/components/section-card";

/** How each kind of row reads to somebody holding the invoice. */
const KIND: Record<CreditLedgerEntry["kind"], string> = {
  signup_grant: "Free credits",
  grant: "Credits added",
  completion: "Model",
  embedding: "Indexing and search",
  transcription: "Dictation",
  composio_call: "Connected app",
  composio_search: "Connected app search",
  browser_task: "Browser task",
};

/** Why a completion happened, when the row says. Anything else reads as the kind. */
const PURPOSE: Record<string, string> = {
  reply: "Reply",
  title: "Conversation title",
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

function label(e: CreditLedgerEntry): string {
  if (e.kind === "completion" && e.purpose && PURPOSE[e.purpose]) return PURPOSE[e.purpose];
  return KIND[e.kind] ?? e.kind;
}

/** Two decimals under one credit, whole credits above — a credit is the unit, not a rounding. */
function amount(n: number): string {
  const abs = Math.abs(n);
  const shown = abs >= 1 ? abs.toFixed(abs >= 100 ? 0 : 1) : abs.toFixed(2);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${shown === "0.00" ? "<0.01" : shown}`;
}

/**
 * What the workspace's credits went on, most recent first, for an admin.
 *
 * **By kind and model, never by person.** The API names the columns it reads
 * and the one that says who caused a charge is not among them — the policy
 * behind the ledger grants it to no reader at all. A workspace's figures are
 * never reported per person (see `0032`), and this list is no exception.
 *
 * Hosted only. A self-hosted install keeps no ledger, and the API answers an
 * empty list there without asking; this renders nothing in that case rather
 * than an empty card about a feature that does not exist.
 */
export function CreditLedger() {
  const hosted = useIsHosted();
  const { data, isLoading } = useQuery({
    queryKey: ["usage", "credit-ledger"],
    queryFn: () => api.creditLedger(50),
    enabled: hosted === true,
  });

  if (hosted !== true) return null;

  const entries = data?.entries ?? [];

  return (
    <>
      <h3 className="mt-10 text-sm font-medium">Where the credits went</h3>
      <SectionCard padded={false} className="mt-3 overflow-hidden">
        {isLoading ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : entries.length === 0 ? (
          <EmptyState
            title="Nothing yet"
            description="Every charge and every top-up shows up here as it happens."
          />
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-hairline text-left text-muted-foreground">
                <th className="px-5 py-2 font-normal">When</th>
                <th className="px-2 py-2 font-normal">What</th>
                <th className="px-2 py-2 font-normal">Model</th>
                <th className="px-5 py-2 text-right font-normal">Credits</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap px-5 py-2 text-muted-foreground">
                    {new Date(e.at).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className="px-2 py-2">{label(e)}</td>
                  <td className="px-2 py-2 text-muted-foreground">{e.model ?? "—"}</td>
                  <td
                    className={
                      e.credits > 0
                        ? "px-5 py-2 text-right font-medium text-foreground"
                        : "px-5 py-2 text-right text-muted-foreground"
                    }
                  >
                    {amount(e.credits)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>
      <p className="mt-3 text-xs text-muted-foreground">
        The last fifty charges and top-ups. A browser task appears twice: a hold when it starts, and
        the difference once the provider says what it really cost.
      </p>
    </>
  );
}
