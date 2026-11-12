import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { ApiError, api, type ApprovalRequest } from "@/lib/api-client";
import { TopBar } from "@/components/top-bar";
import { PageBody } from "@/components/page";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/status-dot";
import { ProposalRows } from "@/components/agent-steps";

export const Route = createFileRoute("/_authed/approvals/$approvalId")({
  component: Approval,
  head: () => ({ meta: [{ title: "Approval · Covan" }] }),
});

/**
 * One request an agent made while nobody was watching (0143): what it wants
 * to do, and the two buttons. The email's link opens this page; opening it
 * changes nothing, and the answer is a POST from a signed-in session.
 *
 * Answering writes the answer and nothing else. The cron carries on with it
 * on its next tick, so after a yes the page says it is carrying on, and keeps
 * asking until the run has.
 */
function Approval() {
  const { t } = useTranslation();
  const { approvalId } = Route.useParams();
  const queryClient = useQueryClient();
  const key = ["approval", approvalId];
  const { data, error, isPending } = useQuery({
    queryKey: key,
    queryFn: () => api.approvals.get(approvalId),
    retry: false,
    // Approved and not yet carried on: look again until the cron has.
    refetchInterval: (query) => {
      const request = query.state.data?.approval;
      return request?.status === "approved" && request.resumedAt === null ? 15_000 : false;
    },
  });
  const answering = useMutation({
    mutationFn: (approve: boolean) => api.approvals.answer(approvalId, approve),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
    },
  });
  const request = data?.approval;
  const late =
    answering.error instanceof ApiError && [404, 409, 410].includes(answering.error.status);

  return (
    <>
      <TopBar title={t("Approval")} />
      <PageBody width="reading">
        {isPending ? (
          <p className="m-0 text-sm text-muted-foreground">{t("Loading…")}</p>
        ) : error || !request ? (
          <p className="m-0 text-sm text-muted-foreground">
            {t("There is nothing here, or it isn't yours to see.")}
          </p>
        ) : (
          <div className="flex items-start gap-3 rounded-xl border border-border p-4">
            <StatusDot state={dotFor(request)} className="mt-[7px]" />
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-sm font-medium">{heading(request, t)}</span>
                <span className="text-sm text-muted-foreground">
                  {request.summary || t("The agent wants to do something.")}
                </span>
                <span className="text-xs text-micro-foreground">
                  {request.tool}
                  {request.status === "pending"
                    ? ` · ${t("waits until {{time}}", {
                        time: new Date(request.expiresAt).toLocaleString(),
                      })}`
                    : ""}
                </span>
              </div>

              <ProposalRows proposal={request.proposal} />

              {request.canAnswer && !late ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button disabled={answering.isPending} onClick={() => answering.mutate(true)}>
                    {answering.isPending ? t("Working…") : t("Approve")}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={answering.isPending}
                    onClick={() => answering.mutate(false)}
                  >
                    {t("Not now")}
                  </Button>
                </div>
              ) : null}

              <p className="m-0 text-meta text-muted-foreground">{whereItStands(request, t)}</p>
              {late ? (
                <p className="m-0 text-meta text-muted-foreground">
                  {t("Somebody answered this first, or it ran out of time.")}
                </p>
              ) : null}
              {answering.error && !late ? (
                <p className="m-0 text-meta text-destructive">
                  {t("Couldn't answer that. Try again.")}
                </p>
              ) : null}

              {request.sessionId && request.agent ? (
                <div>
                  <Button variant="ghost" size="sm" asChild>
                    <Link
                      to="/agents/$agentId/chat"
                      params={{ agentId: request.agent.id }}
                      search={{ s: request.sessionId }}
                    >
                      {t("Open the conversation")}
                    </Link>
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </PageBody>
    </>
  );
}

type T = ReturnType<typeof useTranslation>["t"];

function dotFor(request: ApprovalRequest): "waiting" | "running" | "done" | "idle" {
  if (request.status === "pending") return "waiting";
  if (request.status === "approved" && request.resumedAt === null) return "running";
  if (request.status === "approved") return "done";
  return "idle";
}

function heading(request: ApprovalRequest, t: T): string {
  const agent = request.agent?.name ?? t("An agent");
  if (request.routine) {
    return t("{{agent}} is asking, running “{{routine}}”", {
      agent,
      routine: request.routine.name,
    });
  }
  if (request.origin === "routine") return t("{{agent}} is asking, running a routine", { agent });
  return t("{{name}} is asking you", { name: agent });
}

function whereItStands(request: ApprovalRequest, t: T): string {
  if (request.origin === "chat") {
    return t("This was asked in a conversation. Answer it there.");
  }
  switch (request.status) {
    case "pending":
      return t("Nothing happens until somebody answers. If nobody does, it is not done.");
    case "approved":
      return request.resumedAt === null
        ? t("Approved. The agent carries on within a few minutes.")
        : t("Approved, and the agent carried on.");
    case "declined":
      return t("Declined. The agent didn't do it.");
    default:
      return t("Nobody answered in time, so it was not done.");
  }
}
