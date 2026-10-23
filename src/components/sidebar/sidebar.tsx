import { useRouterState } from "@tanstack/react-router";
import { Plus, Search } from "lucide-react";
import { useTranslation } from "@/i18n";
import { lookup } from "@/i18n";
import { Kbd } from "@/components/kbd";
import { PAGE_NAV, PRIMARY_NAV, primaryNavMatch } from "@/components/primary-nav";
import { useInboxCounts } from "@/hooks/use-inbox";
import { useAgentsStore } from "@/lib/agents-store";
import { useShell } from "@/lib/shell";
import { cn } from "@/lib/utils";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { NavRow, NAV_ROW } from "./nav-rows";
import { AgentRows } from "./agent-rows";
import { CreditsRow } from "./credits-row";
import { AccountRow } from "./account-row";

/**
 * The sidebar (DESIGN.md §6): 248px of `sidebar` grey. The workspace, Search,
 * the six pages, the agents — the one you are in open — and at the foot the
 * credits, Settings and you.
 */
export function Sidebar({ agentId, onNavigate }: { agentId?: string; onNavigate?: () => void }) {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const shell = useShell();
  const { canWrite } = useAgentsStore();
  const { data: counts } = useInboxCounts();
  const page = agentId ? undefined : primaryNavMatch(pathname)?.to;
  const settings = PRIMARY_NAV.find((n) => "bottom" in n)!;

  return (
    <aside
      aria-label={t("Sidebar")}
      className="flex h-full w-[248px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-sidebar p-2"
    >
      <WorkspaceSwitcher onNavigate={onNavigate} />
      <button
        type="button"
        onClick={() => {
          onNavigate?.();
          window.dispatchEvent(new Event("open-command-palette"));
        }}
        className={cn(NAV_ROW, "text-left text-muted-foreground")}
      >
        <Search className="size-4 shrink-0" strokeWidth={1.75} />
        <span className="flex-1">{t("Search")}</span>
        <Kbd>⌘K</Kbd>
      </button>

      <nav aria-label={t("Workspace")} className="mt-1 flex flex-col gap-0.5">
        {PAGE_NAV.map((n) => (
          <NavRow
            key={n.to}
            to={n.to}
            icon={n.icon}
            label={lookup(t, n.label)}
            active={page === n.to}
            count={n.to === "/inbox" ? counts?.unread : undefined}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      <div className="flex items-center justify-between px-2.5 pt-4 pb-1 text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase">
        <span>{t("Agents")}</span>
        {canWrite && (
          <button
            type="button"
            aria-label={t("New agent")}
            onClick={() => {
              onNavigate?.();
              shell.openCreateAgent();
            }}
            className="grid size-5 place-items-center rounded-sm text-micro-foreground hover:bg-sidebar-hover hover:text-foreground"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
        )}
      </div>
      <AgentRows agentId={agentId} onNavigate={onNavigate} />

      <div className="mt-auto flex flex-col gap-0.5 pt-2">
        <CreditsRow onNavigate={onNavigate} />
        <nav aria-label={t("Account")} className="flex flex-col gap-0.5">
          <NavRow
            to={settings.to}
            icon={settings.icon}
            label={lookup(t, settings.label)}
            active={page === settings.to}
            onNavigate={onNavigate}
          />
          <AccountRow onNavigate={onNavigate} />
        </nav>
      </div>
    </aside>
  );
}
