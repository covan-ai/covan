import { cn } from "@/lib/utils";
import { avatarSrc } from "@/lib/avatar-src";

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
  const src = avatarSrc(url);
  if (src) {
    return (
      <img
        src={src}
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

/**
 * A few people, overlapped, and a count for the rest.
 *
 * The team in the app bar and the people an agent is shared with are the same
 * picture at two sizes, so they are one component: `className` sizes each tile
 * (the `+N` tile takes the same box), and the ring is the background's colour
 * so the overlap reads as a cut rather than a border.
 */
export function AvatarStack({
  people,
  max = 4,
  className = "h-7 w-7 text-[10px]",
}: {
  people: { id: string; name: string | null; avatarUrl: string | null }[];
  max?: number;
  className?: string;
}) {
  if (people.length === 0) return null;
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <span className="flex -space-x-1.5">
      {shown.map((p) => (
        <UserAvatar
          key={p.id}
          name={p.name}
          url={p.avatarUrl}
          className={cn("ring-2 ring-background", className)}
        />
      ))}
      {extra > 0 && (
        <span
          className={cn(
            "grid shrink-0 place-items-center rounded-md bg-muted font-semibold text-muted-foreground ring-2 ring-background",
            className,
          )}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}
