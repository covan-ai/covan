import { MiniDemo } from "@/components/welcome/mini-demos";
import type { IntroScreen } from "@/lib/onboarding-config";

/**
 * One capability, no question: a headline with one phrase in the brand
 * colour, a line under it, and the product doing the thing on a loop.
 *
 * The brand colour on one phrase is the same device the front door uses on
 * the agent's name — a pointer at the word that matters, not a decoration —
 * and it is the only amber on the screen besides the progress dot and the
 * primary button.
 */
export function IntroStep({ screen }: { screen: IntroScreen }) {
  const { before, brand, after } = screen.headline;
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <h1 className="text-2xl font-semibold leading-[1.2] tracking-[-0.02em]">
        {before ? `${before} ` : ""}
        <span className="text-brand">{brand}</span>
        {after ? ` ${after}` : ""}
      </h1>
      <p className="mt-2 max-w-sm text-base leading-[1.5] text-muted-foreground">{screen.line}</p>
      <MiniDemo kind={screen.demo} className="mt-8" />
    </div>
  );
}
