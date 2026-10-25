import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { ApiError, api } from "@/lib/api-client";
import { useAgentsStore } from "@/lib/agents-store";
import type { ArrivalScan } from "@/lib/arrivals";
import { browserTimeZone } from "@/lib/timezones";
import { TopBar } from "@/components/top-bar";
import { PageBody } from "@/components/page";
import { Button } from "@/components/ui/button";
import { ArrivalsReport } from "@/components/arrivals/arrivals-report";
import { ConnectCards } from "@/components/arrivals/connect-cards";

type ArrivalsSearch = { scan?: "1" };

export const Route = createFileRoute("/_authed/arrivals")({
  component: Arrivals,
  validateSearch: (search: Record<string, unknown>): ArrivalsSearch =>
    search.scan === "1" || search.scan === 1 ? { scan: "1" } : {},
  head: () => ({ meta: [{ title: "What arrives · Covan" }] }),
});

/** A scan older than this is run again when the page opens. */
const STALE_MS = 7 * 86_400_000;

function stale(scan: ArrivalScan): boolean {
  if (scan.status === "queued" || scan.status === "running") return false;
  return Date.now() - Date.parse(scan.createdAt) > STALE_MS;
}

/**
 * What arrives, outside the welcome (0139): the same report the run ends on,
 * reachable from Routines and from a mailbox's row on Integrations. A page,
 * not under `/routines/`, whose layout reads the next segment as a routine.
 *
 * Opening it scans when there is no scan, when the last one is over a week
 * old, or when the address asks (`?scan=1`); with nothing connected to read,
 * it offers the mailbox and the calendar and scans once one is connected.
 */
function Arrivals() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = Route.useSearch();
  const { agents } = useAgentsStore();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const { data: scan, isPending } = useQuery({
    queryKey: ["arrivals", "latest"],
    queryFn: () => api.arrivals.latest(),
    refetchInterval: (query) =>
      query.state.data?.status === "queued" || query.state.data?.status === "running"
        ? 2_000
        : false,
  });
  const starting = useMutation({
    mutationFn: () => api.arrivals.start(),
    onError: (e) => {
      if (!(e instanceof ApiError && e.status === 409)) {
        toast.error(t("The scan could not start. Try again."));
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["arrivals", "latest"] }),
  });
  const start = starting.mutate;
  // 409: nothing connected that a scan could read.
  const noSource = starting.error instanceof ApiError && starting.error.status === 409;

  const started = useRef(false);
  useEffect(() => {
    if (isPending || started.current) return;
    if (scan === null || search.scan === "1" || (scan && stale(scan))) {
      started.current = true;
      start();
    }
  }, [isPending, scan, search.scan, start]);

  // The agent the welcome made, if it is still one of this workspace's —
  // it may have been deleted, or made in another workspace — else the first.
  const agentId = agents.find((a) => a.id === me?.onboarding?.agentId)?.id ?? agents[0]?.id ?? "";
  const settled = scan && (scan.status === "done" || scan.status === "failed");

  return (
    <>
      <TopBar
        title={t("What arrives")}
        actions={
          settled && !noSource ? (
            <Button variant="secondary" onClick={() => start()}>
              {t("Scan again")}
            </Button>
          ) : undefined
        }
      />
      <PageBody width="reading">
        {noSource ? (
          <div className="space-y-4">
            <p className="m-0 text-sm text-muted-foreground">
              {t("Connect your mailbox or your calendar to see what arrives there.")}
            </p>
            <ConnectCards returnTo="/arrivals" onConnected={() => start()} />
          </div>
        ) : scan ? (
          <ArrivalsReport
            scan={scan}
            agentId={agentId}
            email={me?.user.email ?? ""}
            timezone={me?.workspace.timezone ?? browserTimeZone() ?? "UTC"}
            onDone={() => void navigate({ to: "/routines" })}
            onSkip={() => void navigate({ to: "/routines" })}
            onRetry={() => start()}
          />
        ) : (
          <p className="m-0 text-sm text-muted-foreground">{t("Loading…")}</p>
        )}
      </PageBody>
    </>
  );
}
