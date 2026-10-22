import { Link } from "@tanstack/react-router";
import type { InboxItem } from "@/lib/api-client";
import { AgentMark } from "@/components/agent-mark";
import { StatusDot } from "@/components/status-dot";
import { inboxDot, inboxLine } from "@/lib/inbox";
import { shortTime } from "@/lib/day-groups";
import { cn } from "@/lib/utils";

/**
 * A thread in the Inbox (A4): the agent's 40px mark with a dot at its corner,
 * the title and whose it is, and the line that says why it is here. Unread
 * is heavier and ink; read is muted. Opening it reads it.
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
  const agentName = agent?.name ?? "An agent";
  const line = inboxLine(item, agentName);
  const read = !item.unread && !item.needsYou;
  const whose = [
    agentName,
    item.sharedBy ? `shared by ${item.sharedBy}` : null,
    item.kind === "routine" ? "routine" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Link
      to="/agents/$agentId/chat"
      params={{ agentId: item.agentId }}
      search={{ s: item.sessionId }}
      onClick={() => onOpen(item)}
      className="flex items-center gap-3.5 border-b border-hairline px-3 py-3 hover:bg-surface-muted max-lg:px-0"
    >
      <span className="relative shrink-0">
        <AgentMark agent={{ name: agentName, avatar: agent?.avatar ?? null }} size={40} />
        <span className="absolute -right-[3px] -bottom-[3px] grid size-3 place-items-center rounded-full bg-background">
          <StatusDot state={inboxDot(item)} className="size-2" />
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("min-w-0 truncate text-sm", read ? "font-medium" : "font-semibold")}>
            {item.title ?? "Untitled thread"}
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
          {shortTime(item.lastActivityAt, now)}
        </span>
        {item.unreadCount > 0 && (
          <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
            {item.unreadCount}
          </span>
        )}
      </span>
    </Link>
  );
}
