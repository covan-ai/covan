"use client";

import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/*
 * prompt-kit's `prompt-input`, copied and edited.
 *
 * Upstream: https://www.prompt-kit.com/c/prompt-input.json
 * MIT, Copyright (c) 2025 Julien Thibeaut. See THIRD-PARTY-NOTICES.md.
 *
 * WHAT WAS CHANGED, AND WHY. Read this before re-copying anything from
 * upstream — the third edit is load-bearing and re-copying the file
 * reintroduces a bug in two languages' worth of typing.
 *
 * 1. `shadow-xs` removed from the container. A shadow on a card instead of a
 *    border and a surface step is failure mode #3 of this design system.
 *
 * 2. `bg-background` → `bg-popover`. The composer being white is a deliberate
 *    promotion here (`--popover: #ffffff`, "white is a promotion"); upstream's
 *    default drops it to the canvas it is sitting on.
 *
 * 3. THE KEYBOARD ORDER IS INVERTED. Upstream's `handleKeyDown` binds
 *    Enter-without-shift to submit and calls the caller's `onKeyDown` AFTER it
 *    has already run `preventDefault()` and `onSubmit()`. That order breaks two
 *    documented behaviours of this composer, both silently:
 *
 *      - the `e.nativeEvent.isComposing` guard, without which a Japanese,
 *        Chinese or Korean sentence posts itself one word in, as soon as the
 *        first Enter commits a candidate;
 *      - the mobile branch, where Enter inserts a newline, without which every
 *        paragraph break on a phone sends the message.
 *
 *    So: the caller goes first, and submit happens only `if
 *    (!e.defaultPrevented)`. A caller that wants Enter for itself calls
 *    `preventDefault()` and is obeyed.
 *
 *    AND the submit is conditional on there being an `onSubmit` at all, which
 *    is the other half of the same fix. Inverting the order is not enough on
 *    its own: both behaviours above work by letting the key through
 *    UNTOUCHED — the IME needs its Enter, the phone needs its newline — so
 *    neither calls `preventDefault()`, and upstream would have called it for
 *    them a line later. A composer that owns Enter outright passes no
 *    `onSubmit` and keeps every key it did not ask about.
 *
 * `rounded-3xl` became `rounded-5xl` (20px, the composer's own step on this
 * system's radius ladder — the one object on the chat screen that is held
 * rather than read) and the composer carries the one floating shadow,
 * because it is the one thing on the chat screen that floats.
 *
 * `text-primary` on the textarea is upstream's and is kept: `--primary` and
 * `--foreground` are the same ink in both themes here, so it is already the
 * right colour and renaming it would be divergence that buys nothing.
 */

type PromptInputContextType = {
  isLoading: boolean;
  value: string;
  setValue: (value: string) => void;
  maxHeight: number | string;
  onSubmit?: () => void;
  disabled?: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
};

const PromptInputContext = createContext<PromptInputContextType>({
  isLoading: false,
  value: "",
  setValue: () => {},
  maxHeight: 240,
  onSubmit: undefined,
  disabled: false,
  textareaRef: React.createRef<HTMLTextAreaElement>(),
});

function usePromptInput() {
  return useContext(PromptInputContext);
}

/**
 * Whether the last thing the person did was move focus with the keyboard.
 *
 * For EDIT 8 below. `:focus-visible` was tried first and is not usable for
 * this: Chrome grants it to focus that a closing menu hands back to its
 * trigger, because the menu item before it had been focused by script. So
 * the question is asked of the input itself: Tab and the arrow keys are
 * keyboard navigation, a pointer press ends it, and Escape is neither — a
 * mouse user closing a menu with Escape has not started navigating by key.
 *
 * One listener pair for the module, in capture, so it sees the key before a
 * menu swallows it.
 */
let keyboardNavigating = false;
if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Tab" || e.key.startsWith("Arrow")) keyboardNavigating = true;
    },
    true,
  );
  window.addEventListener(
    "pointerdown",
    () => {
      keyboardNavigating = false;
    },
    true,
  );
}

export type PromptInputProps = {
  isLoading?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  maxHeight?: number | string;
  onSubmit?: () => void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
} & React.ComponentProps<"div">;

function PromptInput({
  className,
  isLoading = false,
  maxHeight = 240,
  value,
  onValueChange,
  onSubmit,
  children,
  disabled = false,
  onClick,
  ...props
}: PromptInputProps) {
  const [internalValue, setInternalValue] = useState(value || "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleChange = (newValue: string) => {
    setInternalValue(newValue);
    onValueChange?.(newValue);
  };

  /**
   * EDIT 6. Clicking the composer's PADDING focuses the textarea. Clicking a
   * control inside it does not.
   *
   * Upstream focuses on any click anywhere in the container, and only
   * `PromptInputAction` stops propagation — which wraps send and stop alone.
   * Everything else this composer holds (attach, report, mic, a receipt's
   * dismiss, and the bundle popover that renders inline inside this container
   * rather than in a portal) would therefore raise the virtual keyboard over
   * the content on a phone, on every tap. That is the mobile half of failure
   * mode #5 arriving by the back door.
   */
  const handleClick: React.MouseEventHandler<HTMLDivElement> = (e) => {
    const onAControl = (e.target as HTMLElement).closest(
      "button, a, input, select, textarea, [role='button'], [role='menuitem']",
    );
    if (!disabled && !onAControl) textareaRef.current?.focus();
    onClick?.(e);
  };

  return (
    // One provider per composer, which is upstream's design and is left alone:
    // there is no app-wide `TooltipProvider` anywhere in `src/`, and nesting a
    // second one inside this is what to avoid rather than this one itself.
    <TooltipProvider>
      <PromptInputContext.Provider
        value={{
          isLoading,
          value: value ?? internalValue,
          setValue: onValueChange ?? handleChange,
          maxHeight,
          onSubmit,
          disabled,
          textareaRef,
        }}
      >
        <div
          onClick={handleClick}
          className={cn(
            "cursor-text rounded-5xl border border-input bg-popover p-2 shadow-card",
            disabled && "cursor-not-allowed opacity-60",
            className,
          )}
          {...props}
        >
          {children}
        </div>
      </PromptInputContext.Provider>
    </TooltipProvider>
  );
}

export type PromptInputTextareaProps = {
  disableAutosize?: boolean;
} & React.ComponentProps<typeof Textarea>;

function PromptInputTextarea({
  className,
  onKeyDown,
  disableAutosize = false,
  ...props
}: PromptInputTextareaProps) {
  const { value, setValue, maxHeight, onSubmit, disabled, textareaRef } = usePromptInput();

  const adjustHeight = (el: HTMLTextAreaElement | null) => {
    if (!el || disableAutosize) return;

    el.style.height = "auto";

    if (typeof maxHeight === "number") {
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    } else {
      el.style.height = `min(${el.scrollHeight}px, ${maxHeight})`;
    }
  };

  const handleRef = (el: HTMLTextAreaElement | null) => {
    textareaRef.current = el;
    adjustHeight(el);
  };

  useLayoutEffect(() => {
    if (!textareaRef.current || disableAutosize) return;

    const el = textareaRef.current;
    el.style.height = "auto";

    if (typeof maxHeight === "number") {
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    } else {
      el.style.height = `min(${el.scrollHeight}px, ${maxHeight})`;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, maxHeight, disableAutosize]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    adjustHeight(e.target);
    setValue(e.target.value);
  };

  /**
   * EDIT 3. The caller is asked first; this submits only if the caller left
   * the event alone. Upstream does the opposite — see the file header.
   */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || !onSubmit) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <Textarea
      ref={handleRef}
      value={value}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      className={cn(
        "min-h-[44px] w-full resize-none border-none bg-transparent text-primary shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0",
        className,
      )}
      rows={1}
      disabled={disabled}
      {...props}
    />
  );
}

export type PromptInputActionsProps = React.HTMLAttributes<HTMLDivElement>;

function PromptInputActions({ children, className, ...props }: PromptInputActionsProps) {
  return (
    <div className={cn("flex items-center gap-2", className)} {...props}>
      {children}
    </div>
  );
}

export type PromptInputActionProps = {
  className?: string;
  tooltip: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
} & React.ComponentProps<typeof Tooltip>;

function PromptInputAction({
  tooltip,
  children,
  className,
  side = "top",
  ...props
}: PromptInputActionProps) {
  const { disabled } = usePromptInput();

  /**
   * EDIT 8. The tooltip opens for a pointer, or for a keyboard, and not for
   * focus that merely came back.
   *
   * Radix opens a tooltip on any focus of its trigger. Three of the controls
   * on this row open a menu, and when a menu closes it hands focus back to
   * the control that opened it — so every pick from the model menu ended
   * with the model's tooltip sitting over the composer, and it stayed there
   * until something else took focus. Clicking the control again opened and
   * closed the menu, which handed focus back again, which opened the tooltip
   * again.
   *
   * So the open is gated: the pointer is over the control, or the person is
   * moving focus by keyboard (`keyboardNavigating`, above). A keyboard user
   * tabbing onto Send still reads what it is waiting for; a mouse user
   * picking a model does not get a label for the thing they just used.
   */
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const hovering = useRef(false);
  // NATIVE listeners, not React's `onPointerEnter`/`onPointerLeave`. React
  // works those out from its own tree, in which a menu rendered through a
  // portal is still a child of the control that opened it — so moving the
  // pointer from the control into its menu never counted as leaving, and the
  // guard below let the tooltip through. The DOM knows the menu is elsewhere.
  useEffect(() => {
    const el = triggerRef.current;
    if (!el) return;
    const enter = () => {
      hovering.current = true;
    };
    const leave = () => {
      hovering.current = false;
    };
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
    };
  }, []);
  const onOpenChange = (next: boolean) => {
    if (next && !hovering.current && !keyboardNavigating) return;
    setOpen(next);
  };

  return (
    // `disableHoverableContent`: the content is a sentence, never a control,
    // so there is nothing to keep it open for while the pointer travels to it.
    // Without this, a tooltip that focus had opened outlived the pointer
    // leaving its control, and sat there until something else took focus.
    <Tooltip open={open} onOpenChange={onOpenChange} disableHoverableContent {...props}>
      {/*
        EDIT 7. The trigger is a SPAN AROUND the child, not the child itself.
        Upstream passes `asChild`, which makes the control the trigger — and a
        disabled control receives no pointer events in any browser, so Radix
        never fires on it. The send button is disabled in exactly the state
        whose tooltip is worth reading ("waiting for the current reply to
        finish"), so with `asChild` that sentence can never appear. The
        `title` attribute it replaced did appear there, because browser chrome
        draws it rather than the page.
      */}
      <TooltipTrigger asChild disabled={disabled} onClick={(event) => event.stopPropagation()}>
        <span ref={triggerRef} className="inline-flex">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side={side} className={className}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

export { PromptInput, PromptInputTextarea, PromptInputActions, PromptInputAction };
