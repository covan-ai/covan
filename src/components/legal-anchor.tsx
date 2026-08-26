import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { LegalLink } from "@/lib/legal";

/**
 * One link to a legal document, wherever `lib/legal.ts` says that document is.
 *
 * The two halves of a legal link are owned by different modules — `lib/legal.ts`
 * decides the destination, the caller decides how it looks — and that seam is
 * where a dead link hides. This exists so the third caller did not become a
 * third copy of the internal/external branch: an operator's configured URL
 * needs `<a rel="noreferrer">`, a built-in page needs `<Link>`, and confusing
 * the two shows up as a route that silently full-page reloads.
 *
 * `newTab` is a decision about what is behind the link rather than about the
 * link. The sign-up form and the app both have state a reader would lose;
 * the landing page's footer has nothing to lose.
 */
export function LegalAnchor({
  link,
  children,
  variant = "inline",
  newTab = false,
}: {
  link: LegalLink;
  children: ReactNode;
  /** `inline` underlines for running text; `plain` inherits its surroundings. */
  variant?: "inline" | "plain";
  newTab?: boolean;
}) {
  const className =
    variant === "inline"
      ? "text-foreground underline underline-offset-4 hover:no-underline"
      : undefined;
  const target = newTab ? "_blank" : undefined;

  if (link.external) {
    return (
      <a href={link.href} target={target} rel="noreferrer" className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link to={link.href} target={target} className={className}>
      {children}
    </Link>
  );
}
