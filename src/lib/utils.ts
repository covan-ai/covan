import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge, told about the type ladder's own steps (DESIGN.md §3).
 * Without them it reads `text-meta` or `text-title-lg` as a colour, and a
 * later `text-muted-foreground` silently removes the size.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["meta", "lead", "title", "title-lg"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
