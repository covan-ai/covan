import logoUrl from "@/assets/logo.png";
import { cn } from "@/lib/utils";

/**
 * The Covan brand mark: the logo on an ink tile — the same lockup the OG image
 * and the favicons carry. Size via `className`.
 *
 * The mark is painted in the tile's own foreground rather than drawn as an
 * `<img>`, because `--primary` inverts between themes: a fixed light logo would
 * sit invisible on the near-white tile dark mode gives it. `logo.png` is used
 * only for its alpha channel, as a mask — its pixels never reach the screen.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <div className={cn("grid h-8 w-8 place-items-center rounded-lg bg-primary", className)}>
      <span
        role="img"
        aria-label="Covan logo"
        className="h-3/5 w-3/5 bg-primary-foreground"
        style={{
          maskImage: `url(${logoUrl})`,
          maskSize: "contain",
          maskRepeat: "no-repeat",
          maskPosition: "center",
          WebkitMaskImage: `url(${logoUrl})`,
          WebkitMaskSize: "contain",
          WebkitMaskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
        }}
      />
    </div>
  );
}
