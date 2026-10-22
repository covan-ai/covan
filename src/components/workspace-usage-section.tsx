import { useQuery } from "@tanstack/react-query";
import { AgentMark } from "@/components/agent-mark";
import { DataTable } from "@/components/data-table";
import { SectionLabel } from "@/components/section";
import { api, type AgentUsage } from "@/lib/api-client";

const compact = (v: number) =>
  v >= 1_000_000
    ? `${(v / 1_000_000).toFixed(1)}M`
    : v >= 1_000
      ? `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`
      : String(v);

// `<$0.01` is for an amount too small to print, not for the absence of one: an
// agent that really spent nothing reads `$0.00`.
const usd = (v: number) => (v === 0 ? "$0.00" : v < 0.01 ? "<$0.01" : `$${v.toFixed(2)}`);

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
      <SectionLabel>By agent</SectionLabel>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="overflow-x-auto">
          <DataTable<AgentUsage>
            label="Usage by agent"
            rows={used}
            rowKey={(a) => a.agentId}
            empty={
              <p className="text-sm text-muted-foreground">
                Once anybody talks to an agent, what it costs shows up here.
              </p>
            }
            columns={[
              {
                key: "agent",
                header: "Agent",
                cell: (a) => (
                  <span className="flex items-center gap-2.5 font-medium">
                    <AgentMark agent={a} size={24} />
                    {a.name}
                  </span>
                ),
              },
              {
                key: "model",
                header: "Model now",
                hideBelow: "md",
                cell: (a) => <span className="text-muted-foreground">{a.model}</span>,
              },
              {
                key: "replies",
                header: "Replies",
                num: true,
                cell: (a) => a.messageCount.toLocaleString("en-US"),
              },
              {
                key: "tokens",
                header: "Tokens",
                num: true,
                hideBelow: "md",
                cell: (a) => compact(a.totalTokens),
              },
              {
                key: "cost",
                header: "At list price",
                num: true,
                cell: (a) => usd(a.estCostUsd),
              },
            ]}
          />
        </div>
      )}
      <p className="mt-3 text-meta text-muted-foreground">
        {workspaceWide
          ? "Everyone's conversations together, by agent — never by person."
          : "Your own conversations."}{" "}
        Nothing here is charged to anyone: an install on its own keys pays its providers directly.
      </p>
    </section>
  );
}
