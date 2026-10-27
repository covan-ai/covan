import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { SectionLabel } from "@/components/section";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "@/i18n";
import { api } from "@/lib/api-client";
import { canEditAgent, type AgentAccess } from "@/lib/agent-access";
import { mayGrantStanding } from "@/lib/connections-api";
import { isAdminRole } from "@/lib/roles";
import {
  useConnectionGrants,
  useRemoveConnectionGrant,
  useSetConnectionGrant,
  useToolConnections,
} from "@/hooks/use-connections";

/**
 * What this routine's agent may change without asking, one switch per app.
 *
 * A scheduled run has nobody to ask. Reading needs nobody: an agent reads any
 * app it can reach. A change happens on a schedule only when somebody said
 * "don't ask again" for that app, for this agent (0140) — and this is where a
 * routine's owner sees and says it. The same switch stops the asking in
 * conversations with the agent too, which the sentence under it says.
 *
 * On is a row; off is no row. Only whoever connected an app, or an admin for a
 * shared one, may turn it on, and the policy is what decides; the switch is
 * disabled for anybody else rather than offered and refused. Anybody who can
 * edit the agent may turn it off.
 */
export function RoutineChangesCard({
  agent,
}: {
  agent: {
    id: string;
    name: string;
    myAccess?: AgentAccess;
    connectionsOff?: string[];
  };
}) {
  const { t } = useTranslation();
  const tools = useToolConnections();
  const grants = useConnectionGrants(agent.id);
  const setGrant = useSetConnectionGrant();
  const removeGrant = useRemoveConnectionGrant();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const isAdmin = me ? isAdminRole(me.members?.find((m) => m.id === me.user.id)?.role) : false;
  const editsAgent = agent.myAccess ? canEditAgent({ myAccess: agent.myAccess }) : false;

  const reachable = (tools.data?.connections ?? []).filter(
    (c) =>
      c.status === "active" &&
      c.transport !== "sql" &&
      !(agent.connectionsOff ?? []).includes(c.id),
  );
  if (reachable.length === 0) return null;
  const on = new Set((grants.data?.grants ?? []).map((g) => g.connectionId));
  const busy = setGrant.isPending || removeGrant.isPending;

  return (
    <section className="mt-2">
      <SectionLabel>{t("What it may change without asking")}</SectionLabel>
      <p className="mt-0 mb-3 text-meta text-muted-foreground">
        {t(
          "{{agent}} reads these apps on every run. To change something in one — a draft, a label, a record — on a schedule, it needs the switch on. It stops the asking in conversations with {{agent}} too.",
          { agent: agent.name },
        )}
      </p>
      <ul className="m-0 list-none space-y-3 p-0">
        {reachable.map((c) => {
          const checked = on.has(c.id);
          const mayTurnOn = mayGrantStanding(c, { canEditAgent: editsAgent, isAdmin });
          const disabled = busy || (checked ? !editsAgent : !mayTurnOn);
          const id = `routine-changes-${c.id}`;
          return (
            <li key={c.id} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <label htmlFor={id} className="text-sm">
                  {c.label}
                </label>
                {!checked && !mayTurnOn ? (
                  <p className="m-0 text-meta text-muted-foreground">
                    {t("Only whoever connected it (or an admin, if it is shared) can change this.")}
                  </p>
                ) : null}
              </div>
              <Switch
                id={id}
                aria-label={t("Let {{agent}} change things in {{app}} without asking", {
                  agent: agent.name,
                  app: c.label,
                })}
                checked={checked}
                disabled={disabled}
                onCheckedChange={(next) => {
                  const input = { agentId: agent.id, connectionId: c.id };
                  const onError = (err: unknown) =>
                    toast.error(err instanceof Error ? err.message : t("Could not save that"));
                  if (next) setGrant.mutate(input, { onError });
                  else removeGrant.mutate(input, { onError });
                }}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
