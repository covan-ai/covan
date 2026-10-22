import type { ReactNode } from "react";
import { StatusDot } from "@/components/status-dot";
import type { DotState } from "@/lib/dot-states";
import { cn } from "@/lib/utils";

/**
 * One connected thing on Integrations (A8): its mark, its name, one line on
 * what it does and for whom, how it is doing, and the one button — Manage.
 * Everything else a connection can be asked lives in that button's dialog,
 * so the page is the same height before and after you press anything.
 */
export function IntegrationRow({
  logo,
  name,
  description,
  status,
  action,
  compact,
}: {
  logo: ReactNode;
  name: ReactNode;
  description?: ReactNode;
  status?: { state: DotState; text: string };
  action?: ReactNode;
  /** The 52px row of saved sign-ins, beside the 60px row of connections. */
  compact?: boolean;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-3.5 border-b border-hairline px-1 last:border-b-0",
        compact ? "min-h-[52px]" : "min-h-[60px]",
      )}
    >
      {logo}
      <span className="min-w-0 flex-1 py-2">
        <span className="block truncate text-sm font-medium">{name}</span>
        {description && (
          <span className="block truncate text-meta text-muted-foreground">{description}</span>
        )}
      </span>
      {status && (
        <span className="hidden shrink-0 items-center gap-1.5 text-meta text-muted-foreground sm:inline-flex">
          <StatusDot state={status.state} />
          {status.text}
        </span>
      )}
      {action && <span className="shrink-0">{action}</span>}
    </li>
  );
}

/** One thing that could be connected, in the Available grid (A8). */
export function IntegrationCard({
  logo,
  name,
  description,
  action,
  note,
}: {
  logo: ReactNode;
  name: ReactNode;
  description: ReactNode;
  action?: ReactNode;
  /** Beside the name: "Coming soon", "Not configured". */
  note?: ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-2.5 rounded-[10px] border border-border p-3.5">
      <span className="flex min-w-0 items-center gap-2.5 text-sm font-medium">
        {logo}
        <span className="truncate">{name}</span>
        {note}
      </span>
      <span className="flex-1 text-meta leading-[1.45] text-muted-foreground">{description}</span>
      {action && <span className="w-fit">{action}</span>}
    </li>
  );
}
