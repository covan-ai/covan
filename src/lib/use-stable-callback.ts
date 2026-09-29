import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A callback that keeps one identity for the life of the component and still
 * sees the latest render's state.
 *
 * WHY THIS EXISTS, because a hook like it is usually a smell.
 *
 * `React.memo` compares props by identity. A handler written in a component
 * body is a new function on every render, so a memoised child re-renders
 * anyway and the memo becomes a comment that costs a comparison.
 *
 * `useCallback` is the usual answer and does not reach the chat route. Its
 * handlers close over `active`, `busy`, `submit` and `streamReply`, and none
 * of those is stable either — a dependency array would move the churn one
 * level up rather than stopping it, and making `submit` and `streamReply`
 * stable means making everything THEY close over stable, which is the whole
 * route.
 *
 * The transcript re-renders on every streamed token. Without this, a memoised
 * answer re-renders on every token too, which is exactly the cost the memo was
 * added to remove: a hundred-message transcript parsing a hundred Markdown
 * documents per token.
 *
 * The ref is written in a layout effect rather than during render, so that a
 * render React throws away cannot leave the wrapper pointing at a closure that
 * never happened. The window between render and effect is not reachable by a
 * user event, which is the only thing that calls these.
 */
export function useStableCallback<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const latest = useRef(fn);

  useLayoutEffect(() => {
    latest.current = fn;
  });

  return useCallback((...args: A) => latest.current(...args), []);
}
