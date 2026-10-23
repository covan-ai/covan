import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * A line across the top of the page (DESIGN.md §11, A33): an invitation is
 * 44px on the sidebar grey, anything else 36px on white. One line, the way
 * forward on the right, and a dismiss where it can be put off.
 */
export function Banner({
  kind,
  label,
  leading,
  children,
  actions,
  onDismiss,
}: {
  kind: "invitation" | "notice";
  label: string;
  leading?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="region"
      aria-label={label}
      className={cn(
        "flex items-center gap-2.5 border-b px-4 lg:px-5",
        kind === "invitation"
          ? "min-h-11 border-border bg-sidebar text-sm"
          : "min-h-9 border-hairline bg-background text-meta",
      )}
    >
      {leading}
      <span className="min-w-0 flex-1 py-1.5">{children}</span>
      {actions && <span className="flex shrink-0 items-center gap-1.5">{actions}</span>}
      {onDismiss && (
        <button
          type="button"
          aria-label={t("Dismiss")}
          onClick={onDismiss}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
