import logoUrl from "@/assets/logo.png";
import { cn } from "@/lib/utils";

/**
 * The Covan brand mark: the logo set inside a teal tile so the light logo
 * stays legible on both light and dark surfaces. Size via `className`.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <div
      className={cn("grid h-8 w-8 place-items-center rounded-lg bg-primary shadow-sm", className)}
    >
      <img src={logoUrl} alt="Covan logo" className="h-3/5 w-3/5 object-contain" />
    </div>
  );
}
