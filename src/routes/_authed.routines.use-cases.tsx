import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { lookup, useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { PageBody } from "@/components/page";
import { SectionLabel, SectionTitle } from "@/components/section";
import { Button } from "@/components/ui/button";
import { UseCaseCard } from "@/components/use-cases/use-case-card";
import { cardState, type CardFacts } from "@/components/use-cases/use-case-facts";
import { useConnections, useToolConnections } from "@/hooks/use-connections";
import { useAgentsStore } from "@/lib/agents-store";
import { flushEvents, trackStep } from "@/lib/analytics";
import { api } from "@/lib/api-client";
import { formatRelative } from "@/lib/relative-time";
import { isAdminRole } from "@/lib/roles";
import { useShell } from "@/lib/shell";
import { SECTIONS, USE_CASES, stepIdFor, type UseCase } from "@/lib/use-cases";

export const Route = createFileRoute("/_authed/routines/use-cases")({
  component: UseCases,
  // `?agent=` from an agent's Routines tab: the routines picked here go to it.
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    agent: typeof search.agent === "string" ? search.agent : undefined,
  }),
  head: () => ({ meta: [{ title: "Use cases — Covan" }] }),
});

/**
 * The use cases (spec 2026-10-27-use-cases-design.md, "The page"): every
 * routine and agent in `use-cases.ts` as a card, by area of work, beside the
 * routines list like `/routines/new`.
 *
 * Picking costs no model call and writes nothing. A routine card opens the
 * editor filled in at `?template=`; an agent card opens "New agent" filled in.
 * Cards are shown whatever is missing — "Gmail not connected" is a useful
 * sentence to read — and a viewer sees the same page with nothing to press.
 */
function UseCases() {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const shell = useShell();
  const { agent: asked } = Route.useSearch();
  const { agents, canWrite } = useAgentsStore();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const { data: tools } = useToolConnections();
  const { data: sources } = useConnections();
  const { data: scan } = useQuery({
    queryKey: ["arrivals", "latest"],
    queryFn: () => api.arrivals.latest(),
    enabled: canWrite,
  });

  // The agent from the address, else the one the welcome made if it is still
  // one of this workspace's, else the first: the rule `/arrivals` keeps.
  const agent =
    agents.find((a) => a.id === asked) ??
    agents.find((a) => a.id === me?.onboarding?.agentId) ??
    agents[0];
  const agentId = agent?.id;

  const connected = new Set(
    (tools?.connections ?? [])
      .filter((c) => c.transport === "composio" && c.status === "active" && c.toolkitSlug)
      .map((c) => c.toolkitSlug as string),
  );
  const facts: CardFacts = {
    agentDocumentCount: agent?.documents.length ?? 0,
    isAdmin: isAdminRole(me?.members.find((m) => m.id === me.user.id)?.role),
    gapReportEnabled: me?.workspace.gapReportEnabled ?? false,
    memberCount: me?.members.length ?? 1,
    connected,
    sources: new Set(
      (sources?.connections ?? [])
        .filter((c) => c.status === "active" && !c.needsFolder)
        .map((c) => (c.provider === "notion" ? "notion" : "drive")),
    ),
    agent: agent ? { name: agent.name, webSearch: agent.webSearch } : null,
  };

  const pick = (u: UseCase) => {
    trackStep(stepIdFor(u.id), "viewed");
    void flushEvents();
    if (u.kind === "agent") {
      shell.openCreateAgent({
        name: lookup(t, u.agent.name),
        avatar: u.agent.avatar,
        persona: u.agent.persona,
        webSearch: u.agent.webSearch,
        mode: u.agent.mode,
        trackAs: stepIdFor(u.id),
      });
      return;
    }
    void navigate({ to: "/routines/new", search: { template: u.id, agent: agentId } });
  };

  // `now` left to its default: read inside the helper, not during the render.
  const scanned = scan ? formatRelative(Date.parse(scan.createdAt), undefined, t, locale) : null;
  const firstId = USE_CASES[0]?.id;

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-1.5 lg:px-6">
        <h2 className="m-0 min-w-0 truncate text-lead font-semibold">{t("Use cases")}</h2>
        {canWrite && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button asChild variant="secondary">
              <Link to="/routines/new" search={{ agent: agentId }}>
                {t("Set it up myself")}
              </Link>
            </Button>
          </div>
        )}
      </div>

      <PageBody width="wide">
        <p className="m-0 mb-6 max-w-[60ch] text-sm text-muted-foreground">
          {t(
            "Work people hand to Covan. Each card is a routine or an agent, ready to set up; nothing is created and nothing is read until you confirm.",
          )}
        </p>

        {canWrite && (
          <section className="mb-10 flex flex-col gap-4 rounded-[10px] border border-border bg-surface-muted p-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <h3 className="m-0 text-title font-semibold">{t("Look at your inbox first")}</h3>
              <p className="mt-1 mb-0 text-meta text-muted-foreground">
                {t(
                  "Connect your mailbox or your calendar, and Covan shows what came in over the last thirty days and which of it a routine could take off your hands.",
                )}
              </p>
              {scanned && (
                <p className="mt-1 mb-0 text-meta text-muted-foreground">
                  {t("Scanned {{when}}", { when: scanned })}
                </p>
              )}
            </div>
            <Button asChild className="shrink-0 self-start sm:self-center">
              <Link to="/arrivals">{scan ? t("See what arrived") : t("Scan my inbox")}</Link>
            </Button>
          </section>
        )}

        <SectionTitle
          title={t("Or start from an example")}
          lede={t("Pick one and change anything before it is created.")}
        />

        {SECTIONS.map((section) => {
          const cards = USE_CASES.filter((u) => u.section === section.id);
          return (
            <section key={section.id} aria-label={lookup(t, section.title)}>
              <SectionLabel className="first:mt-8" action={lookup(t, section.qualifier)}>
                {lookup(t, section.title)}
              </SectionLabel>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {cards.map((u) => (
                  <UseCaseCard
                    key={u.id}
                    useCase={u}
                    state={cardState(u, facts, t)}
                    connected={connected}
                    interactive={canWrite}
                    onPick={() => pick(u)}
                    coach={u.id === firstId}
                  />
                ))}
              </div>
            </section>
          );
        })}

        {canWrite && (
          <div className="mt-10 flex flex-col gap-3 border-t border-hairline pt-6 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="m-0 text-sm font-medium">{t("Don't see your work here?")}</p>
              <p className="mt-0.5 mb-0 text-meta text-muted-foreground">
                {t("Say it in one sentence, and the routine's fields fill in for you to check.")}
              </p>
            </div>
            <Button asChild variant="secondary" className="shrink-0 self-start sm:self-center">
              <Link to="/routines/new" search={{ focus: "sentence", agent: agentId }}>
                {t("Describe it in a sentence")}
              </Link>
            </Button>
          </div>
        )}
      </PageBody>
    </div>
  );
}
