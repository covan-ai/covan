import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The 44px list row (DESIGN.md §7): a leading mark, the title 14/500, a line
 * of meta, and whatever belongs on the right. A link when it goes somewhere.
 */
export function Row({
  leading,
  title,
  meta,
  trailing,
  href,
  onClick,
  className,
}: {
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  href?: string;
  onClick?: () => void;
  className?: string;
}) {
  const body = (
    <>
      {leading}
      <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
      {meta && (
        <span className="shrink-0 text-meta whitespace-nowrap text-muted-foreground">{meta}</span>
      )}
      {trailing}
    </>
  );
  const cls = cn(
    "flex min-h-11 items-center gap-3 border-b border-hairline px-2 text-sm last:border-b-0",
    (href || onClick) && "hover:bg-surface-muted",
    className,
  );
  if (href) {
    return (
      <Link to={href} className={cls}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cn(cls, "w-full text-left")}>
        {body}
      </button>
    );
  }
  return <div className={cls}>{body}</div>;
}
