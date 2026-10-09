"use client";

import { ChevronDownIcon } from "lucide-react";
import React, { createContext, useContext, useState } from "react";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";

/*
 * prompt-kit's `reasoning`, copied and edited.
 *
 * Upstream: https://www.prompt-kit.com/c/reasoning.json
 * MIT, Copyright (c) 2025 Julien Thibeaut. See THIRD-PARTY-NOTICES.md.
 *
 * WHAT WAS CHANGED, AND WHY.
 *
 * 1. `import { Markdown } from "./markdown"` → `@/components/markdown`, and
 *    the call site with it: ours takes `{ content, className }` where
 *    upstream's takes its content as children. The registry ships its own
 *    markdown (react-markdown + marked + remark-gfm, and a shiki code block
 *    under it) and we do not take it: ours renders half-finished input on
 *    every token of every streamed reply — an unclosed fence, a table with a
 *    header and no body — and carries KaTeX. Four npm packages avoided.
 *
 * 2. `prose prose-sm dark:prose-invert` dropped from the content wrapper.
 *    There is no typography plugin in this project, so those were three dead
 *    class names; our `Markdown` styles itself.
 *
 * 3. THE AUTO-OPEN EFFECT IS GONE, and the behaviour it produced is derived
 *    instead. Upstream holds `wasAutoOpened` in state and writes `setInternalOpen`
 *    from inside a `useEffect` on `isStreaming`, which this project lints as an
 *    error (`react-hooks/set-state-in-effect`, and `eslint.config.js` records
 *    why: eleven such sites were worked through rather than silenced). Nothing
 *    read `wasAutoOpened` during render, so there was nothing for the state to
 *    be for. Open is now `override ?? isStreaming`, where `override` is only
 *    ever written by the trigger — a reader's click. The three behaviours
 *    survive: open while reasoning arrives, closed once it stops, and a reader
 *    who folded it by hand is not overruled.
 *
 * 5. `inert` WHILE SHUT, and `motion-reduce:transition-none`. Both are about
 *    the fold being a `grid` rather than the `<details>` it replaced: a
 *    browser makes a closed `<details>`'s content unfocusable and still, and
 *    a zero-height grid row keeps its children mounted, focusable and
 *    animated. Without `inert`, a keyboard reader tabs onto an invisible link
 *    inside the reasoning — `markdown.tsx` renders one as a real `<a href>` —
 *    announced by nothing, its focus ring clipped by `overflow-hidden`. And
 *    this fold opens and closes BY ITSELF, which is the kind of motion
 *    `prefers-reduced-motion` is most for; `styles.css` enumerates every other
 *    animation in the app for it.
 *
 * 4. THE HEIGHT IS ANIMATED IN CSS. Upstream measures the content with a
 *    `ResizeObserver`, writes `style.maxHeight` imperatively, and reads
 *    `contentRef.current?.scrollHeight` during render for the initial value —
 *    which this project also lints as an error (`react-hooks/refs`). A
 *    `grid-template-rows: 0fr → 1fr` fold needs no measurement, no observer and
 *    no refs. Where the transition is not supported the fold still opens and
 *    closes correctly; it simply does not animate.
 *
 * WHAT WAS KEPT, and the reason this file was taken rather than written: the
 * three states. It knows whether reasoning is still arriving and folds itself
 * accordingly, which is the whole of what the old `Disclosure label="Thinking"`
 * was missing.
 */

type ReasoningContextType = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
};

const ReasoningContext = createContext<ReasoningContextType | undefined>(undefined);

function useReasoningContext() {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("useReasoningContext must be used within a Reasoning provider");
  }
  return context;
}

export type ReasoningProps = {
  children: React.ReactNode;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  isStreaming?: boolean;
};

function Reasoning({ children, className, open, onOpenChange, isStreaming }: ReasoningProps) {
  /**
   * What the reader asked for, or null if they have not asked.
   *
   * EDIT 3. Null is the state that matters: while nobody has touched the fold
   * it follows the stream, which is the behaviour this component exists for.
   * One click and it stops following and starts obeying.
   */
  const [override, setOverride] = useState<boolean | null>(null);

  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : (override ?? Boolean(isStreaming));

  const handleOpenChange = (newOpen: boolean) => {
    if (!isControlled) {
      setOverride(newOpen);
    }
    onOpenChange?.(newOpen);
  };

  return (
    <ReasoningContext.Provider
      value={{
        isOpen,
        onOpenChange: handleOpenChange,
      }}
    >
      <div className={className}>{children}</div>
    </ReasoningContext.Provider>
  );
}

export type ReasoningTriggerProps = {
  children: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLButtonElement>;

function ReasoningTrigger({ children, className, ...props }: ReasoningTriggerProps) {
  const { isOpen, onOpenChange } = useReasoningContext();

  return (
    <button
      type="button"
      aria-expanded={isOpen}
      className={cn("flex cursor-pointer items-center gap-2", className)}
      onClick={() => onOpenChange(!isOpen)}
      {...props}
    >
      <span className="text-primary">{children}</span>
      <div className={cn("transform transition-transform", isOpen ? "rotate-180" : "")}>
        <ChevronDownIcon className="size-4" />
      </div>
    </button>
  );
}

export type ReasoningContentProps = {
  children: React.ReactNode;
  className?: string;
  markdown?: boolean;
  contentClassName?: string;
} & React.HTMLAttributes<HTMLDivElement>;

function ReasoningContent({
  children,
  className,
  contentClassName,
  markdown = false,
  ...props
}: ReasoningContentProps) {
  const { isOpen } = useReasoningContext();

  // EDIT 1: ours takes the text as a prop rather than as children.
  const content = markdown ? (
    <Markdown content={children as string} className={contentClassName} />
  ) : (
    children
  );

  return (
    // EDIT 4. Two grid rows and a transition between `0fr` and `1fr`: the
    // fold measures itself, so there is nothing to observe and nothing to
    // write back.
    //
    // EDIT 5. `inert` and `aria-hidden` while shut — the children stay mounted
    // at zero height, so without `inert` a link in the reasoning is still a
    // tab stop. `inert` is what takes it out of the tab order; `aria-hidden`
    // says the same thing to a reader that is not tabbing.
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-150 ease-out motion-reduce:transition-none",
        isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
      inert={!isOpen}
      aria-hidden={!isOpen}
      {...props}
    >
      <div className={cn("overflow-hidden text-muted-foreground", !markdown && contentClassName)}>
        {content}
      </div>
    </div>
  );
}

export { Reasoning, ReasoningTrigger, ReasoningContent };
