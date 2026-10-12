import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { creditsFrom, wholeCredits } from "@/lib/credits";

/**
 * The workspace's balance, in the corner of every screen.
 *
 * Hosted only: a self-hosted install answers `metered: false` and this renders
 * nothing. A house workspace shows "Unlimited" rather than a balance nobody is
 * spending against. Shares the `["usage"]` query with the settings card and
 * the composer banner, so all three move together after a reply.
 *
 * The amber square is the same mark the banners use (DESIGN.md: one accent,
 * squares not circles) and appears only once the balance is worth a look.
 */
export function CreditsBadge() {
  const { data } = useQuery({ queryKey: ["usage"], queryFn: api.usage });
  const raw = data?.credits;
  if (!raw || !raw.metered) return null;

  const view = creditsFrom(data);
  const label = raw.unlimited
    ? "Unlimited"
    : `${wholeCredits(view?.balance ?? 0).toLocaleString()} credits`;
  const warn = !raw.unlimited && view !== null && view.level !== "fine";

  return (
    <Link
      to="/settings"
      className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-foreground"
      aria-label={raw.unlimited ? "Unlimited credits" : `${label} left in this workspace`}
      title="Workspace credits"
    >
      {warn && <span className="h-2 w-2 shrink-0 bg-accent-orange" aria-hidden />}
      <span className="tabular-nums">{label}</span>
    </Link>
  );
}
