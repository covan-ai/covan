import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { AgentMark } from "@/components/agent-mark";
import { DataTable } from "@/components/data-table";
import { SectionLabel } from "@/components/section";
import { api, type AgentUsage } from "@/lib/api-client";

const fixed = (v: number, digits: number, locale: string) =>
  v.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });

const compact = (v: number, locale: string) =>
  v >= 1_000_000
    ? `${fixed(v / 1_000_000, 1, locale)}M`
    : v >= 1_000
      ? `${fixed(v / 1_000, v >= 10_000 ? 0 : 1, locale)}k`
      : v.toLocaleString(locale);

// `<$0.01` is for an amount too small to print, not for the absence of one: an
// agent that really spent nothing reads `$0.00`. The narrow symbol, because
// the wide one is "US$" outside the United States and the column is dollars
// whichever region reads it.
const dollars = (v: number, locale: string) =>
  new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
  }).format(v);
const usd = (v: number, locale: string) =>
  v === 0 ? dollars(0, locale) : v < 0.01 ? `<${dollars(0.01, locale)}` : dollars(v, locale);

/**
 * Settings › Usage, on an install that charges nobody (A15, self-hosted): one
 * table, by agent, at list prices — what the provider bills the install
 * directly.
 *
 * An admin sees everyone's conversations together (`workspace_usage_all`,
 * 0032), by agent and never by person; anybody else sees their own, and the
 * sentence under the table says which it is.
 */
export function WorkspaceUsageSection({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  // `["usage"]` is already loaded — it is how the page knows it is not hosted.
  const own = useQuery({ queryKey: ["usage"], queryFn: api.usage });
  const all = useQuery({
    queryKey: ["usage", "workspace"],
    queryFn: api.workspaceUsage,
    enabled: isAdmin,
  });
  // Before its migration the workspace read answers `available: false`; the
  // admin's own figures are still true, so they stand in.
  const workspaceWide = isAdmin && all.data?.available === true;
  const agents = (workspaceWide ? all.data?.agents : own.data?.agents) ?? [];
  const used = agents.filter((a) => a.messageCount > 0);
  const loading = own.isLoading || (isAdmin && all.isLoading);

  return (
    <section>
      <SectionLabel>{t("By agent")}</SectionLabel>
      {loading ? (
        <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
      ) : (
        <div className="overflow-x-auto">
          <DataTable<AgentUsage>
            label={t("Usage by agent")}
            rows={used}
            rowKey={(a) => a.agentId}
            empty={
              <p className="text-sm text-muted-foreground">
                {t("Once anybody talks to an agent, what it costs shows up here.")}
              </p>
            }
            columns={[
              {
                key: "agent",
                header: t("Agent"),
                cell: (a) => (
                  <span className="flex items-center gap-2.5 font-medium">
                    <AgentMark agent={a} size={24} />
                    {a.name}
                  </span>
                ),
              },
              {
                key: "model",
                header: t("Model now"),
                hideBelow: "md",
                cell: (a) => <span className="text-muted-foreground">{a.model}</span>,
              },
              {
                key: "replies",
                header: t("Replies"),
                num: true,
                cell: (a) => a.messageCount.toLocaleString(locale),
              },
              {
                key: "tokens",
                header: t("Tokens"),
                num: true,
                hideBelow: "md",
                cell: (a) => compact(a.totalTokens, locale),
              },
              {
                key: "cost",
                header: t("At list price"),
                num: true,
                cell: (a) => usd(a.estCostUsd, locale),
              },
            ]}
          />
        </div>
      )}
      <p className="mt-3 text-meta text-muted-foreground">
        {workspaceWide
          ? t("Everyone's conversations together, by agent — never by person.")
          : t("Your own conversations.")}{" "}
        {t(
          "Nothing here is charged to anyone: an install on its own keys pays its providers directly.",
        )}
      </p>
    </section>
  );
}
