import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { ApiError, api, type DelegatedApproval, type InboxItem } from "@/lib/api-client";
import { AgentMark } from "@/components/agent-mark";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { inboxDot, inboxLine } from "@/lib/inbox";
import { shortTime } from "@/lib/day-groups";
import { cn } from "@/lib/utils";

/**
 * A thread in the Inbox (A4): the agent's 40px mark with a dot at its corner,
 * the title and whose it is, and the line that says why it is here. Unread
 * is heavier and ink; read is muted. Opening it reads it.
 *
 * A request an agent made while nobody was watching (0143) is answered from
 * the row itself: Approve and Not now sit beside it, outside the link, and the
 * cron carries on with the answer. A conversation's question is answered in
 * its conversation, where the rest of the reply streams, so it has no buttons
 * here.
 */
export function InboxRow({
  item,
  agent,
  onOpen,
  now,
}: {
  item: InboxItem;
  agent: { name: string; avatar: string | null } | undefined;
  onOpen: (item: InboxItem) => void;
  now?: number;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const agentName = agent?.name ?? t("An agent");
  const line = inboxLine(item, agentName, t);
  const read = !item.unread && !item.needsYou;
  const whose = [
    agentName,
    item.sharedBy ? t("shared by {{name}}", { name: item.sharedBy }) : null,
    item.kind === "routine" ? t("routine") : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const request =
    item.needsYou?.kind === "approval" &&
    item.needsYou.pausedTurnId &&
    (item.needsYou.origin === "routine" || item.needsYou.origin === "wake")
      ? item.needsYou.pausedTurnId
      : null;
  return (
    <div className="flex items-center gap-3 border-b border-hairline px-3 hover:bg-surface-muted max-lg:px-0">
      <Link
        to="/agents/$agentId/chat"
        params={{ agentId: item.agentId }}
        search={{ s: item.sessionId }}
        onClick={() => onOpen(item)}
        className="flex min-w-0 flex-1 items-center gap-3.5 py-3"
      >
        <span className="relative shrink-0">
          <AgentMark agent={{ name: agentName, avatar: agent?.avatar ?? null }} size={40} />
          <span className="absolute -right-[3px] -bottom-[3px] grid size-3 place-items-center rounded-full bg-background">
            <StatusDot state={inboxDot(item)} className="size-2" />
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn("min-w-0 truncate text-sm", read ? "font-medium" : "font-semibold")}
            >
              {item.title ?? t("Untitled thread")}
            </span>
            <span className="shrink-0 text-meta whitespace-nowrap text-muted-foreground max-sm:hidden">
              {whose}
            </span>
          </span>
          <span
            className={cn(
              "mt-0.5 block truncate text-sm",
              read ? "text-muted-foreground" : "text-foreground",
            )}
          >
            <span className="text-muted-foreground">{line.who}:</span> {line.text}
          </span>
        </span>
        <span className="flex min-w-16 shrink-0 flex-col items-end gap-1.5">
          <span
            className={cn(
              "text-xs whitespace-nowrap",
              read ? "text-muted-foreground" : "font-medium text-foreground",
            )}
          >
            {shortTime(item.lastActivityAt, now, t, locale)}
          </span>
          {item.unreadCount > 0 && (
            <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
              {item.unreadCount}
            </span>
          )}
        </span>
      </Link>
      {request ? <AnswerButtons requestId={request} /> : null}
    </div>
  );
}

/**
 * Somebody else's routine asking, in an admin's Inbox (0146): whose routine
 * and which, what it wants, and the same two buttons. The title opens the
 * request's page, never the routine's conversation, which is its owner's.
 */
export function DelegatedRow({
  request,
  agent,
}: {
  request: DelegatedApproval;
  agent: { name: string; avatar: string | null } | undefined;
}) {
  const { t } = useTranslation();
  const agentName = agent?.name ?? request.agentName ?? t("An agent");
  return (
    <div className="flex items-center gap-3 border-b border-hairline px-3 hover:bg-surface-muted max-lg:px-0">
      <Link
        to="/approvals/$approvalId"
        params={{ approvalId: request.id }}
        className="flex min-w-0 flex-1 items-center gap-3.5 py-3"
      >
        <span className="relative shrink-0">
          <AgentMark agent={{ name: agentName, avatar: agent?.avatar ?? null }} size={40} />
          <span className="absolute -right-[3px] -bottom-[3px] grid size-3 place-items-center rounded-full bg-background">
            <StatusDot state="waiting" className="size-2" />
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">
            {request.ownerName
              ? t("For {{owner}}'s routine “{{routine}}”", {
                  owner: request.ownerName,
                  routine: request.routineName,
                })
              : t("For the routine “{{routine}}”", { routine: request.routineName })}
          </span>
          <span className="mt-0.5 block truncate text-sm text-foreground">
            <span className="text-muted-foreground">{agentName}:</span>{" "}
            {request.summary || t("The agent wants to do something.")}
          </span>
        </span>
      </Link>
      <AnswerButtons requestId={request.id} />
    </div>
  );
}

/** Approve / Not now for a request nobody was watching, beside its row. */
function AnswerButtons({ requestId }: { requestId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const answer = async (approve: boolean) => {
    setBusy(true);
    try {
      await api.approvals.answer(requestId, approve);
      toast.success(
        approve
          ? t("Approved. The agent carries on within a few minutes.")
          : t("Declined. The agent won't do it."),
      );
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 410) toast.message(t("That request expired. Ask the agent again."));
      else if (status === 404 || status === 409)
        toast.message(t("That request was already answered."));
      else toast.error(t("Couldn't answer that. Try again."));
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
    }
  };
  return (
    <span className="flex shrink-0 items-center gap-2">
      <Button size="sm" disabled={busy} onClick={() => void answer(true)}>
        {t("Approve")}
      </Button>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void answer(false)}>
        {t("Not now")}
      </Button>
    </span>
  );
}
