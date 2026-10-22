import { cn } from "@/lib/utils";
import { monogram } from "@/lib/monogram";

/**
 * A square monogram (DESIGN.md §5): a workspace, a source, an app with no
 * mark of its own. `ink` is the workspace you are in; `neutral` the rest. An
 * image, when there is one (a workspace's icon), fills the same square.
 */
export type TileSize = 16 | 20 | 24 | 28 | 36;

const BOX: Record<TileSize, string> = {
  16: "size-4 rounded-sm text-[9px]",
  20: "size-5 rounded-sm text-[10px]",
  24: "size-6 rounded-md text-[11px]",
  28: "size-7 rounded-md text-[11px]",
  36: "size-9 rounded-lg text-[14px]",
};

export function Tile({
  label,
  size = 24,
  tone = "neutral",
  imageUrl,
  className,
}: {
  /** What the monogram is taken from: a name, or the letters themselves. */
  label: string;
  size?: TileSize;
  tone?: "neutral" | "ink";
  imageUrl?: string | null;
  className?: string;
}) {
  if (imageUrl) {
    return (
      <img src={imageUrl} alt="" className={cn("shrink-0 object-cover", BOX[size], className)} />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center font-semibold tracking-[0.02em]",
        BOX[size],
        tone === "ink" ? "bg-primary text-primary-foreground" : "bg-tile text-tile-foreground",
        className,
      )}
    >
      {monogram(label, size)}
    </span>
  );
}
