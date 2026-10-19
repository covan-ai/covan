import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { DOCS_HOME } from "@/lib/docs";
import { SETTINGS_GROUPS, SETTINGS_PAGES, isSettingsPage } from "./settings-pages";

const ROW =
  "flex shrink-0 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-200";
const ROW_IDLE = "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground";
const ROW_ACTIVE = "bg-sidebar-accent text-sidebar-accent-foreground";

/**
 * The column on the left of the settings card: the way back, the heading, and
 * the pages under the heading each belongs to.
 *
 * Active state comes from the pathname rather than `Link`'s `activeProps`, so
 * the one rule above decides it here and in the tests alike.
 */
export function SettingsNav({ workspaceName }: { workspaceName?: string }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav aria-label="Settings sections" className="flex flex-col gap-0.5">
      <Link to="/app" className={cn(ROW, ROW_IDLE)}>
        <ArrowLeft className="h-4 w-4" />
        Back to app
      </Link>

      <div className="mb-2 mt-4 px-3">
        <div className="text-title-lg font-semibold">Settings</div>
        <div className="truncate text-meta text-muted-foreground">{workspaceName ?? "…"}</div>
      </div>

      {SETTINGS_GROUPS.map((group) => (
        <div key={group.key} className="mt-3">
          <Eyebrow>{group.label}</Eyebrow>
          {SETTINGS_PAGES.filter((page) => page.group === group.key).map((page) => {
            const active = isSettingsPage(pathname, page.to);
            const Icon = page.icon;
            return (
              <Link
                key={page.to}
                to={page.to}
                aria-current={active ? "page" : undefined}
                className={cn(ROW, active ? ROW_ACTIVE : ROW_IDLE)}
              >
                <Icon className={cn("h-4 w-4", active && "text-brand")} />
                {page.label}
              </Link>
            );
          })}
        </div>
      ))}

      <div className="mt-3">
        <Eyebrow>Help</Eyebrow>
        <a href={DOCS_HOME} target="_blank" rel="noreferrer" className={cn(ROW, ROW_IDLE)}>
          <BookOpen className="h-4 w-4" />
          Documentation
        </a>
      </div>
    </nav>
  );
}

/**
 * Which edges of the tab row have tabs past them, for the fade that says so.
 *
 * Four tabs are about 445px and a 390px phone leaves the row about 320, so the
 * last one or two start out of sight. The row always scrolled; nothing said it
 * did — no scrollbar on a phone, no cut-off word with anything after it — and
 * the pilot read "Usa…" as the end of the list (covan-cloud#407).
 */
function useOverflowEdges(ref: React.RefObject<HTMLElement | null>) {
  const [edges, setEdges] = useState({ start: false, end: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((was) => (was.start === start && was.end === end ? was : { start, end }));
  }, [ref]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resize?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      resize?.disconnect();
    };
  }, [ref, measure]);
  return { edges, measure };
}

const FADE = {
  none: undefined,
  end: "linear-gradient(to right, black calc(100% - 32px), transparent)",
  start: "linear-gradient(to right, transparent, black 32px)",
  both: "linear-gradient(to right, transparent, black 32px, black calc(100% - 32px), transparent)",
};

/** The same pages as a row of tabs, for a screen too narrow for the column. */
export function SettingsTabs() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const row = useRef<HTMLElement>(null);
  const { edges, measure } = useOverflowEdges(row);

  // The page you are on, in view: arriving on Account from a link put the one
  // tab that says where you are past the edge of the screen.
  useEffect(() => {
    const active = row.current?.querySelector<HTMLElement>('[aria-current="page"]');
    active?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
    measure();
  }, [pathname, measure]);

  const fade = edges.start ? (edges.end ? "both" : "start") : edges.end ? "end" : "none";
  const mask = FADE[fade];
  return (
    <nav
      ref={row}
      aria-label="Settings pages"
      data-fade={fade}
      className="flex gap-1 overflow-x-auto"
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
    >
      {SETTINGS_PAGES.map((page) => {
        const active = isSettingsPage(pathname, page.to);
        const Icon = page.icon;
        return (
          <Link
            key={page.to}
            to={page.to}
            aria-current={active ? "page" : undefined}
            className={cn(ROW, active ? ROW_ACTIVE : ROW_IDLE)}
          >
            <Icon className={cn("h-4 w-4", active && "text-brand")} />
            {page.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** The 12px uppercase eyebrow, the system's one uppercase role. */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 text-xs font-semibold uppercase tracking-[0.06em] text-micro-foreground">
      {children}
    </div>
  );
}
