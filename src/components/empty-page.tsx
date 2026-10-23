import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "@/i18n";
import { Avatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/status-dot";
import type { DotState } from "@/lib/dot-states";
import { cn } from "@/lib/utils";

/**
 * Nothing here yet (DESIGN.md §11): one sentence saying what will appear and
 * one or two ways forward. A dot where it says something ("Nothing needs
 * you", grey). Never an illustration.
 */
export function EmptyPage({
  title,
  description,
  dot,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  dot?: DotState;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto flex max-w-md flex-col items-center py-20 text-center", className)}>
      <h2 className="m-0 flex items-center gap-2 text-title font-semibold">
        {dot && <StatusDot state={dot} />}
        {title}
      </h2>
      {description && <p className="mt-2 text-sm text-muted-foreground">{description}</p>}
      {actions && <div className="mt-5 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  );
}

/** A drop target or an empty folder: a dashed well with a sentence and its actions. */
export function EmptyWell({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-lg border border-dashed border-input px-6 py-10 text-center",
        className,
      )}
    >
      <div className="text-sm font-medium">{title}</div>
      {description && <p className="mt-1 text-meta text-muted-foreground">{description}</p>}
      {actions && <div className="mt-4 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Where a viewer would write (A31): who they are, what they can do, and the
 * two ways forward — the admins who can change it, and the threads they can
 * read.
 */
export function ReadOnlyNotice({
  workspaceName,
  viewerName,
}: {
  workspaceName: string;
  viewerName?: string | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex max-w-[420px] flex-col items-center py-12 text-center">
      <Avatar name={viewerName} size={32} />
      <h2 className="mt-3 text-title font-semibold">
        {t("You can read {{workspace}}, not change it", { workspace: workspaceName })}
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {t(
          "Viewers see what is shared with them and can follow along in any thread. Starting threads, uploading and editing agents need a Member role, which an admin can give in a minute.",
        )}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button asChild>
          <Link to="/team">{t("See who the admins are")}</Link>
        </Button>
        <Button asChild variant="secondary">
          <Link to="/threads">{t("Browse threads")}</Link>
        </Button>
      </div>
    </div>
  );
}
