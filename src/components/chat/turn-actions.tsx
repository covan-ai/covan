import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * An action on one message. 28px, in a strip under a reply. (The thread's own
 * controls are ordinary `Button`s in the agent's bar since A2.)
 */
export function MsgAction({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "grid h-7 w-7 place-items-center rounded-md transition-colors hover:bg-accent",
        active ? "text-primary" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
