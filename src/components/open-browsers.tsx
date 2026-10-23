import { useState, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useTranslation, type TFunction } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import {
  api,
  type BrowserPlace,
  type OpenConversationBrowser,
  type OpenTakeover,
} from "@/lib/api-client";
import { sessionLabel } from "@/lib/session-label";
import { ApiError } from "@/lib/api-error";
import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/status-dot";

/**
 * The person's browsers that may still be open (Task 3.2, ruling R48): the
 * browser beside each conversation that the agent or the person has, or that
 * nobody has and is not yet stopped, and the browser they opened to sign in
 * (Task 3.1) or a task's takeover.
 *
 * **Each row says where it is, who has it and when it was last used, and
 * offers the way to end it that already exists** — Stop is the panel's close
 * (`POST /browser/sessions/:id/stop`), Close is the takeover's Done — so this
 * screen adds no new way to stop anything, only a place to find them all.
 * Ending one is what saves its sign-ins (*"always stop the session to persist
 * profile state"*), which is why the cookie list above is asked for again.
 *
 * **No Stop on the browser the agent is using** (R17): a stop does not cancel
 * a run, and a run whose browser vanished under it settles as a failure. The
 * row says the agent is using it and links to the conversation, where the
 * panel's own controls are. Stop is drawn from the server's `stoppable`, the
 * stop route's own rule (R50, R51), so it is offered exactly when it works.
 *
 * **No live URL, ever.** The list carries none and this file asks for none:
 * the panel guards that credential, and a settings page only needs to say a
 * browser exists. Named fields only are drawn, so a field that should not be
 * here is not shown even if a response ever carried one.
 */

/** Under its own key; a stop or a close here refreshes it and the cookie list. */
const OPEN_BROWSERS_KEY = ["browser-open"] as const;

/** What a stop or a close here makes stale, wherever it is on screen or in the cache. */
const STALE_AFTER_ENDING = [
  OPEN_BROWSERS_KEY,
  // The sites the jar holds: the stop just saved into it.
  ["browser-profile"],
  // A conversation's panel and the takeover card, if they are cached.
  ["browser-tasks"],
  ["browser-takeover-current"],
] as const;

/** A time today, a date otherwise: minutes matter for a browser, days for a login. */
function clock(at: string, now: number, locale: string): string {
  const date = new Date(at);
  return date.toDateString() === new Date(now).toDateString()
    ? date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(locale);
}

function lastUsed(at: string | null, now: number, t: TFunction, locale: string): string {
  return at ? t("Last used {{when}}", { when: clock(at, now, locale) }) : t("Not used yet");
}

/** The conversation's name, or a neutral line for one the person can no longer open. */
function placeTitle(place: BrowserPlace, t: TFunction): string {
  if (!place.conversation) return t("A conversation you can no longer open");
  // The place carries the title and not the kind, so an untitled brainstorm
  // reads as a thread here until `GET /browser/sessions` says which it is.
  return sessionLabel(place.conversation, t);
}

/**
 * Who has it, true to the sweep (`claim_due_browser_sessions`, 0078): a
 * browser nobody is using is stopped ten minutes after its last run, and one
 * in the person's hands ten minutes after their tab goes quiet. `agent` with
 * nothing running is not "the agent is using it" — R17's reading of the same
 * row in the panel — and no sweep arm claims it, so nothing is promised; the
 * stop route takes it only ten minutes after its last run (ruling R51), so
 * until then the way to end it is the conversation's Take over.
 */
function stateOf(browser: OpenConversationBrowser, t: TFunction): string {
  if (browser.running) return t("The agent is using it");
  if (browser.liveState === "agent") {
    return browser.stoppable
      ? t("The agent had it last and is not using it now")
      : t("The agent had it last — take it over in the conversation to close it");
  }
  if (browser.liveState === "human") return t("You are using it");
  if (browser.liveState === "none" && browser.browserOpen) {
    return t("Idle — it stops by itself about ten minutes after its last use");
  }
  return t("Nobody is using it");
}

/** The status dot: the panel's, at row scale (DESIGN.md §12). */
function Square({ tone }: { tone: "agent" | "person" | "idle" }) {
  return (
    <StatusDot state={tone === "agent" ? "running" : tone === "person" ? "waiting" : "done"} />
  );
}

const ROW =
  "flex min-h-[52px] w-full items-center gap-3.5 border-b border-hairline px-1 py-2 last:border-b-0";

type Ending =
  { kind: "stop"; browser: OpenConversationBrowser } | { kind: "close"; takeover: OpenTakeover };

export function OpenBrowsersList({
  wrap,
}: {
  /** The frame around the list — a settings section — drawn only when there is a list to frame. */
  wrap?: (list: ReactElement) => ReactElement;
} = {}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [ending, setEnding] = useState<Ending | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  // `dataUpdatedAt` is the render's clock: when the list was read, which is
  // what "closes by itself at" and "today" are measured against. A pure value,
  // where `Date.now()` in render is not.
  const {
    data,
    isLoading,
    dataUpdatedAt: now,
  } = useQuery({
    queryKey: OPEN_BROWSERS_KEY,
    queryFn: () => api.browser.open(),
  });

  async function refresh() {
    await Promise.all(
      STALE_AFTER_ENDING.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
  }

  const end = useMutation({
    mutationFn: async (what: Ending) => {
      if (what.kind === "stop") return api.browser.stop(what.browser.id);
      try {
        await api.takeovers.close(what.takeover.id);
      } catch (e) {
        // Already closed — the sweep after its window, or Done in the panel.
        // Nothing is left to close, which is what was asked for.
        if (e instanceof ApiError && e.status === 409) return;
        throw e;
      }
    },
    onSuccess: async () => {
      setEnding(null);
      setRefusal(null);
      await refresh();
    },
    onError: (e: unknown) => {
      setRefusal(
        e instanceof ApiError ? e.message : t("Couldn't stop that browser. Try again in a moment."),
      );
      // A refusal may be a browser that has already gone; the list says so.
      void queryClient.invalidateQueries({ queryKey: OPEN_BROWSERS_KEY });
    },
  });

  if (isLoading || !data) return null;
  const browsers = data.browsers ?? [];
  const takeover = data.takeover ?? null;
  if (browsers.length === 0 && !takeover) return null;

  const begin = (what: Ending) => {
    setRefusal(null);
    setEnding(what);
  };

  const list = (
    <>
      <ul className="m-0 list-none p-0">
        {takeover && (
          <li key={takeover.id} className={ROW}>
            <Square tone="person" />
            <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className="text-sm font-medium leading-tight [overflow-wrap:anywhere]">
                {takeover.forTask ? placeTitle(takeover, t) : t("Your own browser")}
              </span>
              <span className="flex flex-wrap items-center gap-x-2 text-meta leading-tight text-muted-foreground">
                {takeover.agent && (
                  <>
                    <span>{takeover.agent.name}</span>
                    <span aria-hidden="true">·</span>
                  </>
                )}
                <span>
                  {takeover.forTask
                    ? t("Opened for you to sign in")
                    : t("You opened it to sign in")}
                </span>
                <span aria-hidden="true">·</span>
                {/* Past its window it is still open (ruling R49), and the
                    sweep's stop saves the jar as Close does — so the line
                    says what happens either way, not that it is urgent. */}
                <span>
                  {Date.parse(takeover.expiresAt) > now
                    ? t("Closes by itself at {{time}}", {
                        time: clock(takeover.expiresAt, now, locale),
                      })
                    : t(
                        "Time is up. Close it to finish; if you don't, it closes by itself shortly and your sign-ins are still saved.",
                      )}
                </span>
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() => begin({ kind: "close", takeover })}
            >
              {t("Close")}
            </Button>
          </li>
        )}

        {browsers.map((browser) => (
          <li key={browser.id} className={ROW}>
            <Square
              tone={browser.running ? "agent" : browser.liveState === "human" ? "person" : "idle"}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className="text-sm font-medium leading-tight [overflow-wrap:anywhere]">
                {placeTitle(browser, t)}
              </span>
              <span className="flex flex-wrap items-center gap-x-2 text-meta leading-tight text-muted-foreground">
                {browser.conversation && browser.agent && (
                  <>
                    <span>{browser.agent.name}</span>
                    <span aria-hidden="true">·</span>
                  </>
                )}
                <span>{stateOf(browser, t)}</span>
                <span aria-hidden="true">·</span>
                <span>{lastUsed(browser.lastUsedAt, now, t, locale)}</span>
              </span>
            </span>
            {/* Stop only where the server would take it (R50, R51). Otherwise
                the panel is where the agent's browser is handled (R17) — and
                only a conversation the person can still open has one to go
                to; one out of sight gets its Stop ten minutes after its last
                run, so no row is left without a way out for long. */}
            {!browser.stoppable ? (
              browser.conversation &&
              browser.agent && (
                <Button asChild variant="ghost" size="sm" className="shrink-0">
                  <Link
                    to="/agents/$agentId/chat"
                    params={{ agentId: browser.agent.id }}
                    search={{ s: browser.conversation.id }}
                  >
                    {t("Open the conversation")}
                  </Link>
                </Button>
              )
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => begin({ kind: "stop", browser })}
              >
                {t("Stop")}
              </Button>
            )}
          </li>
        ))}
      </ul>

      <AlertDialog
        open={ending !== null}
        onOpenChange={(next) => {
          if (next) return;
          setEnding(null);
          setRefusal(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {ending?.kind === "close"
                ? ending.takeover.forTask
                  ? t("Close this browser?")
                  : t("Close your browser?")
                : t("Stop this browser?")}
            </AlertDialogTitle>
            {/* The panel's own sentence about its close, and Done's about the
                takeover: stopping is what saves the sign-ins. A task's
                takeover runs its task again when it closes (`closeTakeover`),
                so that is said before it happens, not after. */}
            <AlertDialogDescription>
              {ending?.kind === "close"
                ? ending.takeover.forTask
                  ? t(
                      "Closing it saves your sign-ins to your browser profile, and the task it was opened for runs again.",
                    )
                  : t("Closing it saves your sign-ins to your browser profile.")
                : ending?.browser.liveState === "human"
                  ? t(
                      "You are using it. Stopping it ends whatever is open there and saves your sign-ins to your browser profile. The agent opens a browser again the next time it needs one.",
                    )
                  : t(
                      "Stopping it saves your sign-ins to your browser profile. The agent opens a browser again the next time it needs one.",
                    )}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {refusal ? <p className="text-sm leading-[1.45] text-destructive">{refusal}</p> : null}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={end.isPending}>{t("Keep it open")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Kept open so a refusal has somewhere to be read.
                e.preventDefault();
                if (ending) end.mutate(ending);
              }}
              disabled={end.isPending}
            >
              {ending?.kind === "close"
                ? end.isPending
                  ? t("Closing…")
                  : t("Close it")
                : end.isPending
                  ? t("Stopping…")
                  : t("Stop it")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
  return wrap ? wrap(list) : list;
}
