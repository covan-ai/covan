import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { api, ApiError } from "@/lib/api-client";
import type { ChatSession } from "@/lib/agents-store";
import { sessionLabel } from "@/lib/session-label";
import { StatusDot } from "@/components/status-dot";
import { TextPromptDialog } from "@/components/text-prompt-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * One of an agent's threads under it in the sidebar (A2): 30px, indented to
 * 40px, its dot and its title; a menu on hover or focus for the owner.
 */
export function ThreadRow({
  session,
  active,
  mine,
  onRename,
  onDelete,
  onChanged,
  onNavigate,
}: {
  session: ChatSession;
  active: boolean;
  mine: boolean;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onChanged: () => void;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const label = sessionLabel(session, t);
  const dot =
    session.state === "needs_you" ? "waiting" : session.state === "running" ? "running" : "done";
  const share = async () => {
    try {
      await api.sessions.setVisibility(
        session.id,
        session.visibility === "shared" ? "private" : "shared",
      );
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("Couldn't change who can see it."));
    }
  };
  return (
    <div
      className={cn(
        "group flex h-[30px] items-center rounded-md pr-1 hover:bg-sidebar-hover",
        active && "bg-sidebar-accent hover:bg-sidebar-accent",
      )}
    >
      <Link
        to="/agents/$agentId/chat"
        params={{ agentId: session.agentId }}
        search={{ s: session.id }}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 self-stretch pl-10 text-meta",
          active ? "font-medium text-foreground" : "text-chip-foreground",
        )}
      >
        <StatusDot state={dot} />
        <span className="min-w-0 truncate">{label}</span>
        {(session.unread ?? 0) > 0 && !active && (
          <span className="ml-auto pr-1 text-xs font-medium text-muted-foreground">
            {session.unread}
          </span>
        )}
      </Link>
      {mine && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("More for {{thread}}", { thread: label })}
              className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-surface focus-visible:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right">
            <DropdownMenuItem onClick={() => setRenaming(true)}>{t("Rename")}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void share()}>
              {session.visibility === "shared" ? t("Make private") : t("Share with workspace")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onClick={() => onDelete(session.id)}>
              {t("Delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <TextPromptDialog
        open={renaming}
        onOpenChange={setRenaming}
        title={t("Rename thread")}
        label={t("Name")}
        initialValue={session.title ?? ""}
        submitLabel={t("Rename")}
        busyLabel={t("Renaming…")}
        onSubmit={async (title) => {
          onRename(session.id, title);
          return true;
        }}
      />
    </div>
  );
}
