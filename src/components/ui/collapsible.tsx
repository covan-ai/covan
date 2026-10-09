"use client";

import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";

/*
 * shadcn/ui's collapsible (new-york), verbatim but for semicolons.
 *
 * It carries no classes of its own at all — it is three Radix primitives
 * re-exported — so there is nothing here for a design system to disagree with.
 *
 * Arrived with the tool panel: `prompt-kit/tool.tsx` is built on it.
 * `Disclosure` in `section-card.tsx` stays what it is; it is a `<details>` and
 * the two are not interchangeable (this one animates its height and can be
 * driven from outside, that one works with no JavaScript at all).
 */
const Collapsible = CollapsiblePrimitive.Root;

const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger;

const CollapsibleContent = CollapsiblePrimitive.CollapsibleContent;

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
