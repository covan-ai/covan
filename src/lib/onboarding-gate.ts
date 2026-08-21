/**
 * Whether this navigation should be diverted into the first run.
 *
 * A function rather than an inline condition in _authed.tsx because two of its
 * three rules are the kind that break silently: the /welcome exemption is all
 * that stands between this and an infinite redirect, and "do nothing until you
 * know" is what keeps an account whose /me failed from being locked into a
 * wizard it cannot leave. Both are cheap to assert and expensive to discover.
 */
export function onboardingRedirect(input: {
  pathname: string;
  /** `undefined` while /me is loading, or if it failed. */
  completed: boolean | undefined;
}): "/welcome" | null {
  if (input.completed === undefined) return null;
  if (input.completed) return null;
  if (input.pathname === "/welcome") return null;
  return "/welcome";
}
