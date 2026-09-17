import { useLayoutEffect, useRef } from "react";

/**
 * A textarea that is as tall as what has been typed into it.
 *
 * The composer was written for this and never got it. It carries
 * `min-h-[44px] max-h-44 resize-none` and `rows={1}`, which reads like a box
 * that grows to eleven rem and then scrolls — but nothing was growing it, so
 * the maximum was unreachable and the minimum was the only height there was.
 * Anything past one line was written through a 44px slot that scrolled under
 * the caret, which is the wrong way to write the two paragraphs of context
 * that make an agent's answer good.
 *
 * `field-sizing: content` would do this in CSS and is deliberately not used.
 * Firefox does not implement it, and a version of this that works on three
 * browsers out of four is worse than one that works everywhere: the failure
 * is silent, and it is silent in exactly the place somebody is typing.
 *
 * ## Why it measures twice
 *
 * `scrollHeight` is the content's height *or* the element's, whichever is
 * larger — so asking a box that has already been grown how tall its content is
 * gets the answer "as tall as you already are", and a textarea that has been
 * stretched by a long paragraph never shrinks back when the paragraph is
 * deleted. Collapsing to `auto` first is what makes the second read a
 * measurement rather than an echo.
 *
 * Layout effect rather than effect: both writes land in the same frame, so the
 * collapsed state is never painted. In an ordinary effect it is, and the box
 * flickers on every keystroke.
 */
export function useAutoGrow<T extends HTMLTextAreaElement>(value: string) {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return ref;
}
