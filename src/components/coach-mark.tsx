import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useRouterState } from "@tanstack/react-router";
import { lookup, useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/kbd";
import { closeCoachMark, useCoachMark, type CoachMarkRequest } from "@/lib/coach-marks";
import { CTA } from "@/lib/onboarding-config";

/**
 * A spot on one thing on the page, and a sentence about it.
 *
 * Mounted once beside the router's outlet, so a "Try" in the sidebar can
 * point at something on whichever page it just navigated to. The page dims
 * through an SVG mask with a hole cut around the target — the same dim a
 * dialog's overlay uses — and a floating panel sits under the target with the
 * hint, a Got it and an Esc keycap. Nothing in the hole is clickable: a coach
 * mark explains, it does not perform.
 *
 * The target is found by `data-coach`, polled briefly, because the "Try" that
 * opens the mark may have navigated a moment ago and the thing is still on
 * its way. Not found within two seconds means it is not coming, and the mark
 * closes rather than dimming a page over nothing.
 */
export function CoachMarkLayer() {
  const request = useCoachMark();
  if (!request || typeof document === "undefined") return null;
  // Keyed on the request, so a second "Try" is a fresh mark with fresh timers.
  return createPortal(<CoachMark key={request.seq} request={request} />, document.body);
}

/** How long to wait for the target to appear. */
const FIND_WITHIN_MS = 2000;
const PANEL_WIDTH = 300;
const GAP = 12;
const EDGE = 12;
/** Where the panel is assumed to need room, before it has been drawn. */
const PANEL_ROOM = 180;

type Rect = { top: number; left: number; width: number; height: number; radius: number };

/**
 * The target's box, read on every render and whenever the page moves.
 *
 * `useSyncExternalStore` rather than measuring into state from an effect
 * (the lint rule the codebase enforces): the snapshot is a string so React can
 * compare it, and the subscription is resize, scroll and a slow tick for the
 * layout changes nothing announces.
 */
function subscribeLayout(onChange: () => void) {
  window.addEventListener("resize", onChange);
  window.addEventListener("scroll", onChange, true);
  const tick = window.setInterval(onChange, 250);
  return () => {
    window.removeEventListener("resize", onChange);
    window.removeEventListener("scroll", onChange, true);
    window.clearInterval(tick);
  };
}

function rectOf(id: string): string {
  const el = document.querySelector<HTMLElement>(`[data-coach="${id}"]`);
  if (!el) return "";
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return "";
  const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
  return [r.top, r.left, r.width, r.height, radius].map((n) => Math.round(n)).join(",");
}

function parseRect(s: string): Rect | null {
  if (!s) return null;
  const [top, left, width, height, radius] = s.split(",").map(Number);
  return { top, left, width, height, radius };
}

function CoachMark({ request }: { request: CoachMarkRequest }) {
  const { t } = useTranslation();
  const { target } = request;
  const rect = parseRect(
    useSyncExternalStore(
      subscribeLayout,
      () => rectOf(target.id),
      () => "",
    ),
  );
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const gotIt = useRef<HTMLButtonElement>(null);
  /** The page the target was found on. Leaving it closes the mark. */
  const foundOn = useRef<string | null>(null);
  useEffect(() => {
    if (rect && foundOn.current === null) foundOn.current = pathname;
  }, [rect, pathname]);

  // Not coming. Closed from a timer rather than from render, so a target that
  // mounts late still gets its two seconds.
  useEffect(() => {
    if (rect) return;
    const timer = window.setTimeout(() => {
      if (!document.querySelector(`[data-coach="${target.id}"]`)) closeCoachMark();
    }, FIND_WITHIN_MS);
    return () => window.clearTimeout(timer);
  }, [rect, target.id]);

  useEffect(() => {
    if (foundOn.current !== null && pathname !== foundOn.current) closeCoachMark();
  }, [pathname]);

  useEffect(() => {
    if (!rect) return;
    gotIt.current?.focus();
  }, [rect]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeCoachMark();
      } else if (e.key === "Tab") {
        // The panel has one control. Focus stays on it; the page behind is
        // dimmed and is not the thing being read.
        e.preventDefault();
        gotIt.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!rect) return null;

  const hole = {
    x: rect.left - 6,
    y: rect.top - 6,
    width: rect.width + 12,
    height: rect.height + 12,
    rx: rect.radius + 4,
  };
  const below = rect.top + rect.height + GAP + PANEL_ROOM <= window.innerHeight;
  const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - EDGE));
  const panelStyle = below
    ? { top: rect.top + rect.height + GAP, left }
    : { bottom: window.innerHeight - rect.top + GAP, left };
  const titleId = `coach-${target.id}-title`;
  const hintId = `coach-${target.id}-hint`;

  return (
    <div className="fixed inset-0 z-[60]">
      {/* The dim with a hole in it. `fill-opacity` on the ink rather than a
          grey, so it reads the same over both themes. */}
      <svg
        aria-hidden
        onClick={closeCoachMark}
        className="absolute inset-0 h-full w-full animate-in fade-in-0 text-foreground motion-reduce:animate-none"
      >
        <defs>
          <mask id="coach-mark-mask">
            <rect width="100%" height="100%" fill="white" />
            <rect
              x={hole.x}
              y={hole.y}
              width={hole.width}
              height={hole.height}
              rx={hole.rx}
              fill="black"
            />
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="currentColor"
          fillOpacity="0.4"
          mask="url(#coach-mark-mask)"
        />
      </svg>

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hintId}
        style={{ ...panelStyle, width: `min(${PANEL_WIDTH}px, calc(100vw - ${EDGE * 2}px))` }}
        className="step-arrive absolute rounded-xl border border-border bg-popover p-4 shadow-card"
      >
        <p className="m-0 text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase">
          {request.position
            ? `${lookup(t, CTA.try)} · ${t("{{step}} of {{total}}", {
                step: request.position.step,
                total: request.position.total,
              })}`
            : lookup(t, CTA.try)}
        </p>
        <p id={titleId} className="mt-1 text-sm font-semibold">
          {lookup(t, target.title)}
        </p>
        <p id={hintId} className="mt-1 text-meta text-muted-foreground">
          {lookup(t, target.hint)}
        </p>
        <div className="mt-3.5 flex items-center gap-1.5">
          <Button ref={gotIt} size="sm" onClick={closeCoachMark}>
            {lookup(t, CTA.gotIt)}
          </Button>
          {request.onSkip && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                request.onSkip?.();
                closeCoachMark();
              }}
            >
              {t("Skip the tour")}
            </Button>
          )}
          <Kbd className="ml-auto">esc</Kbd>
        </div>
      </div>
    </div>
  );
}
