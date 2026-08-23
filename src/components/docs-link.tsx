import { ArrowUpRight } from "lucide-react";
import { docsUrl, type DocSlug } from "@/lib/docs";
import { cn } from "@/lib/utils";

/**
 * A quiet link from a screen to the page of documentation about it.
 *
 * Deliberately not a button and not amber: it is there for the person who is
 * stuck, and it should be invisible to everyone else. The arrow is the only
 * signal it leaves the app, which it does in a new tab — somebody reading about
 * bundles halfway through making one should still have the half-made one when
 * they come back.
 */
export function DocsLink({
  page,
  children,
  className,
}: {
  page: DocSlug;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={docsUrl(page)}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex items-center gap-1 text-[13px] text-muted-foreground underline-offset-4 transition-colors duration-200 hover:text-foreground hover:underline",
        className,
      )}
    >
      {children}
      <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
    </a>
  );
}
