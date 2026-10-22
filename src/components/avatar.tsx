import { cn } from "@/lib/utils";
import { avatarSrc } from "@/lib/avatar-src";
import { getInitials } from "@/lib/monogram";

export type AvatarSize = 20 | 24 | 32 | 40 | 64;

const BOX: Record<AvatarSize, string> = {
  20: "size-5 text-[9px]",
  24: "size-6 text-[11px]",
  32: "size-8 text-[12px]",
  40: "size-10 text-[14px]",
  64: "size-16 text-[20px]",
};

/**
 * A person (DESIGN.md §5): round, their photo or their initials on the
 * `avatar` grey. Agents are never drawn this way — they are `AgentMark`.
 */
export function Avatar({
  name,
  url,
  size = 24,
  dashed = false,
  className,
}: {
  name: string | null | undefined;
  url?: string | null;
  size?: AvatarSize;
  /** Somebody invited and not here yet: a dashed ring around a "?". */
  dashed?: boolean;
  className?: string;
}) {
  const src = avatarSrc(url);
  if (src) {
    return (
      <img
        src={src}
        alt={name ?? ""}
        className={cn("shrink-0 rounded-full object-cover", BOX[size], className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-semibold",
        BOX[size],
        dashed
          ? "border border-dashed border-input bg-transparent text-muted-foreground"
          : "bg-avatar text-avatar-foreground",
        className,
      )}
    >
      {dashed ? "?" : getInitials(name)}
    </span>
  );
}

/** People overlapping by 6px, the rest as "+3". */
export function AvatarStack({
  people,
  max = 4,
  size = 20,
}: {
  people: Array<{ id: string; name: string | null; avatarUrl?: string | null }>;
  max?: number;
  size?: AvatarSize;
}) {
  const shown = people.slice(0, max);
  const more = people.length - shown.length;
  return (
    <span className="inline-flex items-center">
      {shown.map((p, i) => (
        <Avatar
          key={p.id}
          name={p.name}
          url={p.avatarUrl}
          size={size}
          className={cn("ring-2 ring-background", i > 0 && "-ml-1.5")}
        />
      ))}
      {more > 0 && <span className="ml-1.5 text-xs text-muted-foreground">+{more}</span>}
    </span>
  );
}
