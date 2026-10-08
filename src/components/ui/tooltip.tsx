"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/lib/utils";

/*
 * shadcn/ui's tooltip (new-york), with the two changes every file in this
 * directory gets: semicolons and the Tailwind v4 spelling of the transform
 * origin — `origin-(--radix-…)` rather than `origin-[--radix-…]`, which v4
 * reads as an arbitrary value and silently drops. See the same line in
 * `dropdown-menu.tsx`.
 *
 * Colours are the registry's: ink fill, paper text. That is `bg-primary` here
 * as everywhere, so it is this system's ink rather than shadcn's.
 *
 * Arrived with the composer (prompt-kit's `PromptInputAction` is a tooltip).
 * Its provider is mounted by `PromptInput` itself; there is no app-wide one.
 */
const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--radix-tooltip-content-transform-origin)",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
