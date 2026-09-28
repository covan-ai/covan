import { useState } from "react";
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
 * What has NOT changed is the tile. `DESIGN.md` makes the 44px neutral square
 * the ceiling for anything saturated, and the mark sits inside it at 22px —
 * the same arrangement `brand-marks.tsx` already used for Drive's and Slack's
 * full-colour marks, and the reason that tile was sized as it was.
 */
export function AppLogo({
  src,
  name,
  className,
}: {
  /** Already absolute — build it with `assetSrc`. Empty means go straight to the monogram. */
  src: string;
  /** What the thing is called. Only ever rendered as a monogram. */
  name: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(src) && !failed;

  return (
    <span
      className={cn(
        "grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground ring-1 ring-inset ring-hairline",
        className,
      )}
    >
      {showImage ? (
        <img
          // The name is already beside this tile in every place it is used.
          // A filled `alt` would have a screen reader say it twice.
          alt=""
          src={src}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="h-[22px] w-[22px] object-contain"
        />
      ) : (
        // `text-xs` because `DESIGN.md` puts a monogram there at 36px and up.
        // A monogram is not a type role, which is why it has no step of its own.
        <span className="text-xs font-medium">{getInitials(name)}</span>
      )}
    </span>
  );
}
