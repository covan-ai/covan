import { cn } from "@/lib/utils";

/**
 * The Covan brand mark: the bare logo in the ink colour — black on the light
 * theme, white on the dark one, no tile behind it. Size via `className`.
 *
 * The glyph is inlined rather than loaded as a file because the ink inverts
 * between themes: a fixed black logo would sit invisible on the dark canvas.
 * `currentColor` on the foreground handles that in one line, and an inline
 * path stays sharp at every size — this renders at
 * 32px in the sidebar and much larger on the auth screens.
 *
 * The shape is kept in step with `assets/logo.svg`, which is what the icons in
 * public/ are rendered from.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <div className={cn("grid h-8 w-8 place-items-center text-foreground", className)}>
      <svg
        role="img"
        aria-label="Covan logo"
        viewBox="0 0 150 135"
        fill="currentColor"
        // 2/3 of the tile, matching the icons in public/. The old mark sat at
        // 3/5; this one is four thin courses rather than a solid ring, and at
        // the 32px this renders at in the sidebar the bottom course closes up
        // and the tip disappears at that size. Bigger is legible, not louder.
        className="h-[82%] w-[82%]"
      >
        <polygon points="0,0 150,0 135.42,26.25 14.58,26.25" />
        <polygon points="20.14,36.25 129.86,36.25 115.28,62.5 34.72,62.5" />
        <polygon points="40.28,72.5 109.72,72.5 95.14,98.75 54.86,98.75" />
        <polygon points="60.42,108.75 89.58,108.75 75,135" />
      </svg>
    </div>
  );
}
