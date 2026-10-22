import { useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { TextPromptDialog } from "@/components/text-prompt-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The thread's own line at the top of the transcript (A2): its title at
 * 16/600 and "Started by you · 12 min ago · Private · grounded in 12
 * documents". The bar above the page belongs to the agent; what can be done
 * to this thread is the menu at the end of this line, for its owner.
 */
export function ThreadTitle({
  title,
  meta,
  actions,
}: {
  title: string;
  meta: ReactNode[];
  /** The owner's: what the menu offers. Absent for anybody else. */
  actions?: {
    rename: (title: string) => void;
    shared: boolean;
    setShared: (shared: boolean) => void;
    writeReport?: () => void;
    remove: () => void;
  };
}) {
  const [renaming, setRenaming] = useState(false);
  const parts = meta.filter(Boolean);
  return (
    <div className="mb-7 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-hairline pb-5">
      <h2 className="m-0 min-w-0 text-title font-semibold [overflow-wrap:anywhere]">{title}</h2>
      {parts.length > 0 && (
        <span className="text-meta text-muted-foreground">
          {parts.map((p, i) => (
            <span key={i}>
              {i > 0 && " · "}
              {p}
            </span>
          ))}
        </span>
      )}
      {actions && (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Thread actions"
                className="ml-auto self-center text-muted-foreground"
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={() => setRenaming(true)}>Rename</DropdownMenuItem>
              <DropdownMenuItem onClick={() => actions.setShared(!actions.shared)}>
                {actions.shared ? "Make private" : "Share with workspace"}
              </DropdownMenuItem>
              {actions.writeReport && (
                <DropdownMenuItem onClick={actions.writeReport}>Write a report</DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={actions.remove}>
                Delete thread
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <TextPromptDialog
            open={renaming}
            onOpenChange={setRenaming}
            title="Rename thread"
            label="Name"
            initialValue={title}
            submitLabel="Rename"
            busyLabel="Renaming…"
            onSubmit={async (next) => {
              actions.rename(next);
              return true;
            }}
          />
        </>
      )}
    </div>
  );
}
