import { Link } from "@tanstack/react-router";
import { useCredits } from "@/lib/credits";
import { StatusDot } from "@/components/status-dot";

/**
 * The balance at the foot of the sidebar (DESIGN.md §6): "1,240 credits ·
 * Buy more" over a 3px bar of what is left of what the workspace has had.
 * Hosted only — a self-hosted install has no credits and draws nothing — and
 * the waiting dot when the balance is low.
 */
export function CreditsRow({ onNavigate }: { onNavigate?: () => void }) {
  const credits = useCredits();
  if (!credits) return null;
  return (
    <Link
      to="/settings/usage"
      onClick={onNavigate}
      aria-label={`${credits.balance.toLocaleString("en-US")} credits left. Buy more`}
      className="flex flex-col gap-1.5 rounded-md px-2.5 py-2 hover:bg-sidebar-hover"
    >
      <span className="flex items-center justify-between gap-2 text-meta">
        <span className="flex items-center gap-2 font-medium">
          {credits.level !== "fine" && <StatusDot state="waiting" />}
          {credits.balance.toLocaleString("en-US")} credits
        </span>
        <span className="text-muted-foreground">Buy more</span>
      </span>
      <span className="block h-[3px] rounded-full bg-border">
        <span
          className="block h-[3px] rounded-full bg-primary"
          style={{ width: `${Math.round(credits.ratio * 100)}%` }}
        />
      </span>
    </Link>
  );
}
