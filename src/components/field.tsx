import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A settings row (DESIGN.md §7): a 220px label column — the label and a line
 * of help — and the control beside it, a hairline below. Stacks below `md`.
 */
export function Field({
  label,
  help,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  help?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid items-start gap-2 border-b border-hairline py-5 last:border-b-0 md:grid-cols-[220px_minmax(0,1fr)] md:gap-6",
        className,
      )}
    >
      <div>
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm font-medium">
            {label}
          </label>
        ) : (
          <div className="text-sm font-medium">{label}</div>
        )}
        {help && <div className="mt-0.5 text-meta text-muted-foreground">{help}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Fields one under another, with nothing between them but their hairlines. */
export function FieldStack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col", className)}>{children}</div>;
}
