import { useId } from "react";
import { lookup, msg, useTranslation } from "@/i18n";
import { Chip } from "@/components/chip";
import { AppLogo } from "@/components/integrations/app-logo";
import { StatusDot } from "@/components/status-dot";
import { buttonVariants } from "@/components/ui/button";
import { assetSrc } from "@/lib/api-client";
import { composioLogoPath } from "@/lib/onboarding-config";
import { TOOLKIT_NAME, type AppMark, type UseCase } from "@/lib/use-cases";
import { cn } from "@/lib/utils";
import type { CardState } from "./use-case-facts";

/** A word mark's chip text: keys (`msg`), except the two product names. */
const WORD_MARK: Record<Exclude<AppMark, { toolkit: string }>, string> = {
  knowledge: msg("Knowledge"),
  browser: msg("Browser"),
  web: msg("Web"),
  email: msg("Email"),
  github: "GitHub",
  slack: "Slack",
};

/**
 * One use case as a card: the apps it touches, its title, the prompt that is
 * its body, and a footer with when it runs or what is missing.
 *
 * A bordered card with a 10px corner, no shadow and no tint. That is a
 * recorded departure from DESIGN.md §1 ("a border goes only around what
 * truly stands apart"), scoped to the use-cases page and the welcome's
 * connect step: each card is a thing you pick, and the row form lost the
 * marks and the prompt that make the page legible at a glance (spec
 * 2026-10-27-use-cases-design.md, "Fidelity to DESIGN.md").
 *
 * Interactive and ready, the whole card is the button. Blocked, it says why
 * and offers nothing; not interactive (a viewer, the welcome), it is a
 * picture of the card with nothing to press.
 */
export function UseCaseCard({
  useCase: u,
  state,
  connected,
  interactive,
  onPick,
  coach = false,
}: {
  useCase: UseCase;
  state: CardState;
  /** Composio toolkits with an active connection; a mark not in it is greyed. */
  connected: ReadonlySet<string>;
  interactive: boolean;
  onPick?: () => void;
  /** The first card on the page, which the getting-started coach mark points at. */
  coach?: boolean;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const bodyId = useId();
  const pickable = interactive && state.kind === "ready";

  const content = (
    <>
      <span className="flex h-7 flex-wrap items-center gap-1.5 overflow-hidden">
        {u.apps.map((mark) => {
          if (typeof mark === "string") {
            return <Chip key={mark}>{lookup(t, WORD_MARK[mark])}</Chip>;
          }
          const name = TOOLKIT_NAME[mark.toolkit] ?? mark.toolkit;
          const on = connected.has(mark.toolkit);
          return (
            <span
              key={mark.toolkit}
              role="img"
              aria-label={on ? name : t("{{app}} not connected", { app: name })}
              className={cn("inline-flex", !on && "opacity-40")}
            >
              <AppLogo src={assetSrc(composioLogoPath(mark.toolkit))} name={name} size={28} />
            </span>
          );
        })}
      </span>
      <span id={titleId} className="block text-sm font-semibold">
        {lookup(t, u.label)}
      </span>
      <span
        id={bodyId}
        className="line-clamp-3 block flex-1 text-meta leading-[1.45] text-muted-foreground"
      >
        {lookup(t, u.prompt)}
      </span>
      <span className="mt-1 flex items-end justify-between gap-3">
        {state.kind === "blocked" ? (
          <span className="flex items-start gap-2 text-meta text-muted-foreground">
            <StatusDot state="waiting" className="mt-1.5" />
            <span>{state.reason}</span>
          </span>
        ) : (
          <span className="flex min-w-0 flex-col gap-0.5 text-meta text-muted-foreground">
            <span>{state.schedule}</span>
            {state.notes.map((note) => (
              <span key={note} className="flex items-center gap-2">
                <StatusDot state="waiting" />
                <span className="min-w-0">{note}</span>
              </span>
            ))}
          </span>
        )}
        {pickable && (
          // A look, not an element: the card is already the button, and a
          // button inside a button is not one a keyboard can reach.
          <span
            aria-hidden
            className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "shrink-0")}
          >
            {u.kind === "agent" ? t("Create") : t("Set up")}
          </span>
        )}
      </span>
    </>
  );

  const frame = "flex min-w-0 flex-col gap-2 rounded-[10px] border border-border p-3 text-left";
  if (pickable) {
    return (
      <button
        type="button"
        onClick={onPick}
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-coach={coach ? "use-case-card" : undefined}
        className={cn(frame, "bg-background hover:bg-surface-muted")}
      >
        {content}
      </button>
    );
  }
  return (
    <div data-coach={coach ? "use-case-card" : undefined} className={frame}>
      {content}
    </div>
  );
}
