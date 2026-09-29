import { useState, type ComponentType } from "react";
import { getInitials } from "@/components/avatars";
import { cn } from "@/lib/utils";

/**
 * The mark of an application we did not draw.
 *
 * WHY THERE ARE LOGOS NOW, since the card above this one argued at length that
 * there could not be. Two of the three reasons were real and one had quietly
 * stopped being true. The CSP was never the obstacle — the deployed policy is
 * `frame-ancestors 'none'` and has no `img-src` at all (`src/start.ts`) — so
 * that half of the argument was describing a header we do not send. What was
 * real: fifteen hundred requests to somebody else's CDN tells that CDN who is
 * reading our Integrations page, and a logo that 404s is worse than no logo.
 * Both are answered rather than avoided. The address is a path on our own API
 * (`GET /composio/logo`, which fetches only from two allowlisted hosts), so
 * the page still speaks to nobody but us; and a bad answer becomes a monogram
 * on this line rather than a broken image.
 *
 * What has NOT changed is the ceiling. `DESIGN.md` makes the 44px neutral
 * square the largest anything saturated gets, and the mark sits inside it at
 * 22px. What HAS changed is that 44 is no longer the only size: the tile turns
 * up at three jobs now, and the smaller two are proportional steps down from
 * that same arrangement rather than new ones.
 */

/**
 * The three tiles, and everything that scales with them.
 *
 * A table and not arithmetic, because Tailwind generates classes by reading the
 * source: a computed `h-[${size / 2}px]` produces no CSS at all and fails by
 * painting nothing. The mark is half the tile at every step — the 22-in-44
 * proportion `DESIGN.md` fixed — and the monogram follows the type ladder's own
 * rule for a glyph in a tile: `text-[10px]` up to 28, `text-xs` from 36.
 *
 * The radius does not move. 10px is the row it sits in, and a 28px chip with
 * an 8px corner inside a 10px row is failure mode #4 — a child rounder than
 * its parent — for the sake of two pixels nobody asked for.
 */
const TILE = {
  28: { box: "h-7 w-7", mark: "h-[14px] w-[14px]", monogram: "text-[10px]" },
  36: { box: "h-9 w-9", mark: "h-[18px] w-[18px]", monogram: "text-xs" },
  44: { box: "h-11 w-11", mark: "h-[22px] w-[22px]", monogram: "text-xs" },
} as const;

export function AppLogo({
  src,
  mark: Mark,
  name,
  size = 44,
  className,
}: {
  /** Already absolute — build it with `assetSrc`. Empty means go straight to the monogram. */
  src?: string;
  /**
   * A mark we hold ourselves, for the sources drawn inline rather than fetched
   * (`brand-marks.tsx`). The component and not an element: the tile decides how
   * big a mark is, and an element handed in already sized would be the caller
   * deciding instead — which is the bug this component grew a `size` to end.
   *
   * Takes precedence over `src`. A drawing we ship cannot fail to load.
   */
  mark?: ComponentType<{ className?: string }>;
  /** What the thing is called. Only ever rendered as a monogram. */
  name: string;
  /** 44 on Integrations, 36 in a connected app's row, 28 in a chip. */
  size?: 28 | 36 | 44;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const tile = TILE[size];
  const showImage = Boolean(src) && !failed;

  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-lg bg-background text-muted-foreground ring-1 ring-inset ring-hairline",
        tile.box,
        className,
      )}
    >
      {Mark ? (
        <Mark className={tile.mark} />
      ) : showImage ? (
        <img
          // The name is already beside this tile in every place it is used.
          // A filled `alt` would have a screen reader say it twice.
          alt=""
          src={src}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className={cn(tile.mark, "object-contain")}
        />
      ) : (
        // A monogram is not a type role, which is why it has no step of its
        // own — it is sized by the tile it sits in. See `TILE`.
        <span className={cn(tile.monogram, "font-medium")}>{getInitials(name)}</span>
      )}
    </span>
  );
}
