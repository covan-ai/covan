import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { useShell } from "@/lib/shell";
import { useTranslation } from "@/i18n";

/**
 * The bar every page opens with (DESIGN.md §6): 48px, white, a bottom border.
 * Its grammar is fixed — title (with a mark inside an agent) · meta · tabs ·
 * actions, the primary one last — so no page invents its own header.
 *
 * Below `lg` it is the phone's 56px bar: the drawer button, the title and up
 * to two icon actions (`phoneActions`); tabs drop to a scrolling row under it.
 */
export function TopBar({
  title,
  leading,
  meta,
  phoneMeta,
  tabs,
  actions,
  phoneActions,
  slot = false,
  className,
}: {
  title: ReactNode;
  leading?: ReactNode;
  meta?: ReactNode;
  /** The phone's shorter meta beside the title (A20: "Inbox 3"). */
  phoneMeta?: ReactNode;
  tabs?: ReactNode;
  actions?: ReactNode;
  phoneActions?: ReactNode;
  /** Leave room for a child route's actions (`TopBarPortal`), before `actions`. */
  slot?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const shell = useShell();
  return (
    <header className={cn("sticky top-0 z-20 border-b border-border bg-background", className)}>
      <div className="flex h-14 items-center gap-2 px-4 lg:h-12 lg:gap-3 lg:px-5">
        <button
          type="button"
          onClick={shell.openDrawer}
          aria-label={t("Open the menu")}
          className="-ml-1.5 grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-surface lg:hidden"
        >
          <Menu className="size-4" strokeWidth={1.75} />
        </button>
        <h1 className="flex min-w-0 items-center gap-2 text-lead font-semibold">
          {leading}
          <span className="truncate">{title}</span>
          {phoneMeta !== undefined && (
            <span className="text-meta font-medium text-muted-foreground lg:hidden">
              {phoneMeta}
            </span>
          )}
        </h1>
        {meta && (
          <span className="hidden truncate text-meta text-muted-foreground lg:inline">{meta}</span>
        )}
        {tabs && <div className="hidden self-stretch lg:flex">{tabs}</div>}
        <div className="ml-auto flex items-center gap-2">
          {/* A child route's own actions — Save on Configuration, the
              thread's search — are its only controls, so they show at every
              width; the bar's own actions give way to `phoneActions`. */}
          {slot && <TopBarSlot />}
          <div className="hidden items-center gap-2 lg:flex empty:hidden">{actions}</div>
          {phoneActions && <div className="flex items-center gap-1 lg:hidden">{phoneActions}</div>}
        </div>
      </div>
      {tabs && (
        <div className="flex h-11 overflow-x-auto border-t border-hairline px-2 lg:hidden">
          {tabs}
        </div>
      )}
    </header>
  );
}

const SlotContext = createContext<{
  el: HTMLElement | null;
  set: (el: HTMLElement | null) => void;
} | null>(null);

/** Lets a child route put its actions into its parent's bar. */
export function TopBarSlotProvider({ children }: { children: ReactNode }) {
  const [el, set] = useState<HTMLElement | null>(null);
  return <SlotContext.Provider value={{ el, set }}>{children}</SlotContext.Provider>;
}

/** Where the portal's actions land, inside `TopBar slot`. */
export function TopBarSlot({ className }: { className?: string }) {
  const ctx = useContext(SlotContext);
  return <div ref={ctx?.set} className={cn("flex items-center gap-2 empty:hidden", className)} />;
}

/** A child route's actions, drawn in its parent's bar; nothing outside one. */
export function TopBarPortal({ children }: { children: ReactNode }) {
  const ctx = useContext(SlotContext);
  return ctx?.el ? createPortal(children, ctx.el) : null;
}
