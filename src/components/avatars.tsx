import { cn } from "@/lib/utils";

/** "Ada Lovelace" -> "AL". Falls back to a dash so a row never looks broken. */
export function getInitials(name: string | null | undefined, fallback = "–"): string {
  if (!name) return fallback;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
}

/*
 * Squares, not circles.
 *
 * The design system puts circles in exactly two places, both window-chrome
 * imitations. Everything else — bullets, marks, avatars, tiles — is a square
 * with a radius from the ladder. A round avatar is the cheapest way to drift
 * off-system, so these are rounded squares at the 8px step (§7.8).
 */
const TILE = "grid shrink-0 place-items-center rounded-md font-semibold tracking-[0.03em]";

/** A person. Photo when we have one, monogram on a neutral tile when we don't. */
export function UserAvatar({
  name,
  url,
  className,
}: {
  name: string | null | undefined;
  url?: string | null;
  className?: string;
}) {
  if (url) {
    return (
      <img
        src={url}
        alt={name ?? ""}
        className={cn("shrink-0 rounded-md object-cover", className)}
      />
    );
  }
  return (
    <div className={cn(TILE, "bg-surface text-muted-foreground", className)} aria-hidden>
      {getInitials(name, "…")}
    </div>
  );
}

/**
 * An agent.
 *
 * `neutral` is the default and the one to reach for in any list: a surface
 * tile, so a grid of twelve agents does not put twelve amber squares on screen.
 * `accent` is the amber mark from §7.8, and it is for the *singular* context —
 * the agent you are currently in. Accent discipline caps a viewport at roughly
 * five orange elements; a gallery would blow through that on its own.
 */
export function AgentAvatar({
  emoji,
  tone = "neutral",
  className,
}: {
  /** Kept in the signature so callers stay unchanged; identity is the emoji. */
  id?: string;
  emoji: string;
  tone?: "neutral" | "accent";
  className?: string;
}) {
  return (
    <span
      className={cn(
        TILE,
        tone === "accent"
          ? "bg-accent-orange text-accent-orange-foreground"
          : "bg-surface text-muted-foreground ring-1 ring-inset ring-hairline",
        className,
      )}
      aria-hidden
    >
      {emoji}
    </span>
  );
}
