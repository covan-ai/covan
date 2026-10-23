import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, X } from "lucide-react";
import {
  api,
  type ConversationBrowser,
  type LiveState,
  type TakeOverResult,
} from "@/lib/api-client";
import { ApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/status-dot";
import { SignInCard } from "./sign-in-card";
import {
  browserKey,
  canContinue,
  eventId,
  isRunning,
  openInNewWindow,
  ran,
  signInFor,
  useConversationBrowser,
  waitingFor,
} from "./use-conversation-browser";
import { safeNavigationUrl } from "@/lib/safe-url";
import { lookup, msg, useTranslation, type TFunction } from "@/i18n";
import { useLocale } from "@/i18n/provider";

/**
 * The browser beside the conversation.
 *
 * While the agent browses, its browser is on screen next to the chat: the
 * provider's live view in a frame, what the agent did in a short list under
 * it, and a pill that says who has the controls. The person can take them —
 * the agent's run is cancelled, the session and its browser are kept — and
 * hand them back with Done, which continues the task in the same browser (the
 * one free retry, as the takeover always was).
 *
 * Everything the panel knows comes from one poll, `GET /sessions/:id/browser-
 * tasks`, which is also the live endpoint: each ask checks the run with the
 * provider and settles it the moment it has ended. Except the live URL. That
 * comes from `GET /browser/sessions/:id/live` and lives in this component's
 * state for the life of the tab, for the reason browser-use gives in five
 * words — *"Treat the URL as a credential"* — so it is in no query key, no
 * query cache, no storage, no log line and no error message. A reload loses
 * it and the next mount asks again, which is what the route's idempotence is
 * for (Review focus 3).
 */

/** How long to wait before asking again after take-over answered `cancelling`. */
const TAKE_OVER_RETRY_MS = 2_000;
/** How many times to ask again before handing the person a "Try again". */
const TAKE_OVER_RETRIES = 5;

function messageOf(err: unknown, t: TFunction): string {
  return err instanceof Error && err.message ? err.message : t("Something went wrong.");
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const GAVE_UP = msg("The agent has not let go of the browser yet. Try again in a moment.");

/** A queued task's place, as the list says it. The server keeps at most three waiting. */
const PLACES = [msg("Up next"), msg("Second in line"), msg("Third in line")];

/** The server's sentences start in lower case, for splicing; on their own they are sentences. */
function sentence(text: string, locale: string): string {
  return text ? text.charAt(0).toLocaleUpperCase(locale) + text.slice(1) : text;
}

/**
 * The person's own browser (Task 3.1): a takeover with no task behind it,
 * opened from this panel to sign in ahead of time. `liveUrl` is the same
 * credential the agent's view is, and kept the same way — see the file's note.
 */
type OwnBrowser = { id: string; liveUrl: string | null; expiresAt: string };

export function BrowserPanel({
  sessionId,
  agentId,
  canShare = false,
  onHide,
  layout = "float",
  agentName,
}: {
  sessionId: string;
  /** The conversation's agent: what a login saved from the sign-in card is saved for. */
  agentId?: string;
  /** Whether the person may save a login for everyone using the agent: not a viewer (R34). */
  canShare?: boolean;
  onHide: () => void;
  /** `float` beside the chat at `lg` and up (A13); `sheet` full-height below it. */
  layout?: "float" | "sheet";
  /** Who is browsing: "Finance is browsing". */
  agentName?: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, dataUpdatedAt } = useConversationBrowser(sessionId);
  const session = data?.session ?? null;
  const running = (data?.tasks ?? []).some(isRunning);
  const prompt = signInFor(data);
  const continuable = canContinue(data);
  // Tasks waiting their turn in this browser (0080), next in line first.
  const line = waitingFor(data);
  const liveState: LiveState = session?.liveState ?? "none";

  /**
   * The live URL, and why there is none when there is none.
   *
   * Component state on purpose — see the file's note. Minted on mount, again
   * when the provider first reports a browser (or reports it gone), again
   * after a take-over (`mints`), again when a new task starts — a run after an
   * idle stop is in a browser the provider has just given the session — and,
   * while a run is going with no view on screen, on each poll (at most every
   * three seconds): the first mint usually lands before the provider has a
   * browser, and `browserReady` may already have been true from the run
   * before, so no flip would come to ask again (final-review I3).
   */
  const [live, setLive] = useState<{ url: string | null; problem: string | null }>({
    url: null,
    problem: null,
  });
  const [mints, setMints] = useState(0);
  const browserId = session?.id ?? null;
  const browserReady = session?.browserReady ?? false;
  // The newest task the browser ran: one only waiting its turn changes nothing on screen.
  const newestTask = data?.tasks.find(ran)?.id ?? null;
  // The poll's tick, as a reason to mint again: a later answer than the one
  // already acted on, while a run is going and nothing is on screen. The first
  // answer is the mount's own mint, so it is not counted twice.
  const lastPoll = useRef(0);
  const viewMissing = running && !live.url;
  useEffect(() => {
    const previous = lastPoll.current;
    lastPoll.current = dataUpdatedAt;
    if (!previous || previous === dataUpdatedAt || !viewMissing) return;
    setMints((n) => n + 1);
  }, [dataUpdatedAt, viewMissing]);
  useEffect(() => {
    if (!browserId) return;
    let current = true;
    api.browser.live(browserId).then(
      (minted) => {
        if (current) setLive({ url: safeNavigationUrl(minted.liveUrl), problem: null });
      },
      (err: unknown) => {
        if (!current) return;
        // 409 is "no browser is running yet" — the run is still starting it.
        const notYet = err instanceof ApiError && err.status === 409;
        setLive({ url: null, problem: notYet ? null : messageOf(err, t) });
      },
    );
    return () => {
      current = false;
    };
    // `browserReady` and the newest task are triggers, not inputs: each is a
    // moment the browser on screen may no longer be the browser there is.
    // `t` changes only with the language, and a fresh mint then is harmless.
  }, [browserId, browserReady, mints, newestTask, t]);

  /**
   * Take-over's own clock.
   *
   * `trying` from the click until the server answers `human`; `gave-up` after
   * five more asks two seconds apart all answered `cancelling`. The frame stays
   * inert through both — the agent's run has been asked to stop and has not
   * said it has, and it may be in the middle of typing (Review focus 2).
   */
  const [takeOverState, setTakeOverState] = useState<"idle" | "trying" | "gave-up">("idle");
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * The person's own browser, if one is open (Task 3.1).
   *
   * Asked for once on mount, which is the reload recovery: the live URL is in
   * component state and nowhere else, so a reloaded tab re-mints it from the
   * open row through `GET /browser/takeovers/current`, as the transcript card
   * does for a task's takeover. **Only a takeover with no task is this
   * panel's** (ruling R43) — one opened for a task belongs to the v2 card in
   * the transcript, which claims only a takeover whose task is in its
   * conversation, so the two never both claim one. A failed ask is no
   * browser: Open browser is still there, and its 409 says if one is open.
   */
  const [own, setOwn] = useState<OwnBrowser | null>(null);
  useEffect(() => {
    let current = true;
    api.takeovers.current().then(
      ({ takeover }) => {
        if (!current || !takeover || takeover.browserTaskId) return;
        setOwn({
          id: takeover.id,
          liveUrl: safeNavigationUrl(takeover.liveUrl),
          expiresAt: takeover.expiresAt,
        });
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, []);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  function patchLiveState(next: LiveState, humanSince: number | null) {
    queryClient.setQueryData<ConversationBrowser>(browserKey(sessionId), (old) =>
      old?.session ? { ...old, session: { ...old.session, liveState: next, humanSince } } : old,
    );
  }

  const takeOver = useMutation({
    mutationFn: async (id: string): Promise<TakeOverResult> => {
      for (let attempt = 0; ; attempt++) {
        const result = await api.browser.takeOver(id);
        if (result.liveState === "human" || attempt >= TAKE_OVER_RETRIES || !alive.current) {
          return result;
        }
        await wait(TAKE_OVER_RETRY_MS);
      }
    },
    onMutate: () => {
      setTakeOverState("trying");
      setProblem(null);
    },
    onSuccess: (result) => {
      if (result.liveState !== "human") {
        setTakeOverState("gave-up");
        return;
      }
      setTakeOverState("idle");
      patchLiveState("human", result.humanSince);
      setMints((n) => n + 1);
      void queryClient.invalidateQueries({ queryKey: browserKey(sessionId) });
    },
    onError: (err) => {
      setTakeOverState("idle");
      setProblem(messageOf(err, t));
      // A 409 here is usually a browser that has closed (final-review I2); the
      // server has forgotten it, and asking now drops the sign-in prompt
      // rather than leaving it pointing at nothing until the next poll.
      void queryClient.invalidateQueries({ queryKey: browserKey(sessionId) });
    },
  });

  const handBack = useMutation({
    // A site only after a save on the sign-in card (R24); the server finds the
    // login itself, so nothing secret is in these variables.
    mutationFn: ({
      id,
      site,
      credentialId,
    }: {
      id: string;
      site?: string;
      credentialId?: string;
    }) => (site ? api.browser.handBack(id, { site, credentialId }) : api.browser.handBack(id)),
    onMutate: () => setProblem(null),
    onSuccess: () => {
      // Inert again before the next poll: a run has just been started in this
      // browser, and the frame must not stay in the person's hands under it.
      patchLiveState("agent", null);
      void queryClient.invalidateQueries({ queryKey: browserKey(sessionId) });
    },
    // A 409 is a sentence worth reading — "already tried again", "nothing to
    // continue" — so it goes beside the button rather than into a toast.
    onError: (err) => setProblem(messageOf(err, t)),
  });

  const stop = useMutation({
    mutationFn: (id: string) => api.browser.stop(id),
    onMutate: () => setProblem(null),
    onSuccess: () => {
      setConfirmingClose(false);
      setLive({ url: null, problem: null });
      patchLiveState("none", null);
      void queryClient.invalidateQueries({ queryKey: browserKey(sessionId) });
      // Closing takes what was waiting out of the line, and says so in the
      // conversation (0080).
      if (line.length > 0) {
        void queryClient.invalidateQueries({ queryKey: ["messages", sessionId] });
      }
      onHide();
    },
    onError: (err) => setProblem(messageOf(err, t)),
  });

  /** Take one task out of the line before its turn (0080). */
  const removeWaiting = useMutation({
    mutationFn: (taskId: string) => api.browser.removeWaiting(taskId),
    onMutate: () => setProblem(null),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: browserKey(sessionId) }),
    // A 409 is a task that started meanwhile: the sentence says so.
    onError: (err) => {
      setProblem(messageOf(err, t));
      void queryClient.invalidateQueries({ queryKey: browserKey(sessionId) });
    },
  });

  const mode: "agent" | "human" | "cancelling" | "idle" =
    takeOverState !== "idle"
      ? "cancelling"
      : liveState === "human"
        ? "human"
        : liveState === "agent" && running
          ? "agent"
          : "idle";
  /** The person's hands on the frame — in human mode and no other. */
  const interactive = mode === "human";
  /**
   * The edge that breathes: only while the agent holds the browser AND a run is
   * going. `agent` alone is not enough — an abandoned take-over can leave the
   * row there with nothing running, and an amber edge breathing over a browser
   * nobody is using is the indicator lying.
   */
  const hairline = liveState === "agent" && running;

  /**
   * Close. Stopping is what saves the sign-ins (*"always stop the session to
   * persist profile state"*), but it does not cancel a run, and a run whose
   * browser vanished under it settles as a failure. So while one is going,
   * close only hides the panel; otherwise it stops, after one line saying the
   * sign-ins are kept. And while the row says the agent has the browser, run
   * or no run: the stop route refuses there (ruling R50), and a "Close the
   * browser?" answered with its 409 would be the panel arguing with itself.
   * Take over, then close, is the way out of that state, and the pill offers
   * the first half.
   */
  function close() {
    if (!session || running || liveState === "agent") {
      onHide();
      return;
    }
    setConfirmingClose(true);
  }

  /**
   * The browser in a tab of its own. From the sign-in prompt it takes the
   * controls first, so Done works when the person comes back; from the header
   * it only shows the same browser bigger.
   */
  function openWindow(takeOverFirst: boolean) {
    if (!session) return;
    const id = session.id;
    setProblem(null);
    openInNewWindow(async () => {
      if (takeOverFirst && liveState !== "human") {
        const result = await takeOver.mutateAsync(id);
        if (result.liveState !== "human") throw new Error(lookup(t, GAVE_UP));
      }
      return (await api.browser.live(id)).liveUrl;
    }, t).catch((err: unknown) => setProblem(messageOf(err, t)));
  }

  /**
   * A login was just saved from the sign-in card: the one free retry, with it
   * (R24). Hand-back continues only a browser in the person's hands, and the
   * browser at a wall is nobody's, so it is taken over first — the same
   * take-over Just this once makes, with its wait for the agent to let go —
   * and then handed back naming the site. The server resolves the login; the
   * password went to the save and nowhere near this.
   */
  async function continueWithLogin(site: string, credentialId: string) {
    if (!session) return;
    const id = session.id;
    setProblem(null);
    if (liveState !== "human") {
      let taken: TakeOverResult;
      try {
        taken = await takeOver.mutateAsync(id);
      } catch {
        return; // `takeOver`'s own onError has said why, beside the button.
      }
      if (taken.liveState !== "human") {
        setProblem(lookup(t, GAVE_UP));
        return;
      }
    }
    handBack.mutate({ id, site, credentialId });
  }

  /**
   * The person's own browser, or the offer of one (Task 3.1, ruling R42).
   *
   * Offered whenever this conversation has no browser to show: none ever, or
   * one that has been stopped. The row outlives its browser — the idle stop
   * and a close clear the browser but keep the session, which the next run
   * continues — so "no browser" is a row that is nobody's, names no browser
   * (`browserReady` false) and has nothing running, not a missing row. Without
   * that, Open browser was unreachable in any conversation that ever browsed.
   *
   * And the person's own, once open, is shown over a conversation browser
   * nobody is using, so its Done can always be found from here — but never
   * over one the agent or the person holds. Under rulings R44 and R46 the two
   * cannot both be live; if a race ever makes them so, the live conversation
   * browser and its controls keep the panel.
   */
  const nobodys = !session || (session.liveState === "none" && !running);
  const nothingToShow = !!data && (!session || (nobodys && !session.browserReady));
  if ((own && nobodys) || nothingToShow) {
    // `problem` goes along: a Take over that found the browser gone is what
    // switches this view in, and its sentence is the explanation of the switch.
    return (
      <OwnBrowserView
        own={own}
        onChange={setOwn}
        onHide={onHide}
        layout={layout}
        notice={problem}
      />
    );
  }

  const status =
    mode === "agent" || mode === "cancelling"
      ? t("The agent is driving")
      : mode === "human"
        ? t("You are driving")
        : t("Nobody is driving");
  const placeholder = live.problem
    ? live.problem
    : session && (running || liveState !== "none")
      ? t("Starting the browser…")
      : line.length > 0
        ? t("Starting the next task…")
        : t("No browser is open right now.");
  const pill = pillOf({
    mode,
    ready: browserReady || !!live.url,
    signIn: !!prompt,
    takeOverState,
    donePending: handBack.isPending,
    continuable,
    onTakeOver: () => session && takeOver.mutate(session.id),
    onDone: () => session && handBack.mutate({ id: session.id }),
    onClose: close,
    t,
  });
  const task = (data?.tasks ?? []).find(isRunning) ?? null;
  const latest = data?.events.length ? data.events[data.events.length - 1] : null;

  return (
    <BrowserFrame
      layout={layout}
      live={hairline}
      dot={
        mode === "agent" || mode === "cancelling"
          ? "running"
          : mode === "human"
            ? "waiting"
            : "done"
      }
      status={status}
      title={
        mode === "agent" || mode === "cancelling"
          ? agentName
            ? t("{{name}} is browsing", { name: agentName })
            : t("The agent is browsing")
          : mode === "human"
            ? t("Your hands on the browser")
            : t("Browser")
      }
      task={task?.task ?? null}
      action={pill.action}
      onOpenWindow={session ? () => openWindow(false) : undefined}
      onClose={close}
      footer={
        <>
          <span
            className={cn(
              "min-w-0 truncate",
              mode === "agent" && latest && "font-medium text-foreground",
            )}
          >
            {mode === "agent" && latest ? (
              // The provider publishes no event catalogue, so a line with
              // nothing to say shows its type rather than vanishing.
              <span key={eventId(latest)}>{latest.text || latest.type}</span>
            ) : (
              pill.text
            )}
          </span>
          {task && <Elapsed since={task.createdAt} />}
        </>
      }
      notices={
        <>
          {confirmingClose && session && (
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-sm">
                {t("Close the browser? Closing it saves your sign-ins to your profile.")}
                {line.length > 0 && " "}
                {line.length > 0 &&
                  t("The task waiting for it won't run.", {
                    count: line.length,
                    defaultValue_other: "The {{count}} tasks waiting for it won't run.",
                  })}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingClose(false)}>
                {t("Keep it open")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={stop.isPending}
                onClick={() => stop.mutate(session.id)}
              >
                {t("Close it")}
              </Button>
            </div>
          )}
          {prompt && (
            <SignInCard
              host={prompt.signInHost}
              carriedSavedLogin={prompt.carriedSavedLogin}
              savedLogin={prompt.savedLogin}
              agentId={agentId}
              canShare={canShare}
              opening={takeOver.isPending}
              onJustThisOnce={() => session && takeOver.mutate(session.id)}
              onOpenWindow={() => openWindow(true)}
              onSaved={(site, credentialId) => void continueWithLogin(site, credentialId)}
            />
          )}
          {/* Ruling R21: the sweep stops a browser about ten minutes after
              the tab holding it goes quiet (this tab's poll is the heartbeat,
              every minute or so). Said beside Done, so walking away is a
              choice. */}
          {mode === "human" && (
            <p className="text-meta text-muted-foreground">
              {t("The browser closes about ten minutes after this tab is closed.")}
            </p>
          )}
          {problem && (
            <p role="alert" className="text-meta text-destructive">
              {problem}
            </p>
          )}
        </>
      }
      after={
        /* The line (0080): what starts by itself when the browser is free,
           next first. Remove takes one out before its turn; a task that has
           started is the take-over's, not this list's. */
        line.length > 0 && (
          <section
            aria-label={t("Queued tasks")}
            className="flex max-h-48 flex-col gap-1.5 overflow-y-auto border-t border-hairline p-3"
          >
            <h3 className="text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase">
              {t("Queued")}
            </h3>
            <ol className="flex flex-col gap-1.5">
              {line.map((task, i) => (
                <li
                  key={task.id}
                  className="flex items-start gap-2 rounded-lg border border-border px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-meta text-muted-foreground">
                      {PLACES[i]
                        ? lookup(t, PLACES[i])
                        : t("Number {{place}} in line", { place: i + 1 })}
                    </p>
                    <p className="line-clamp-2 text-sm [overflow-wrap:anywhere]">{task.task}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={removeWaiting.isPending}
                    onClick={() => removeWaiting.mutate(task.id)}
                  >
                    {t("Remove")}
                  </Button>
                </li>
              ))}
            </ol>
          </section>
        )
      }
    >
      {/*
        Inert, untabbable and deaf to the pointer while anybody but the person
        has the controls — and that is a courtesy, not a lock. browser-use says
        so outright: *"View-only embeds are a UI restriction, not a
        server-enforced permission."* Whoever holds the URL can drive the
        browser, which is why the URL is the thing kept close (*"Treat the URL
        as a credential"*), and why this wrapper only stops a stray click from
        landing in the middle of the agent's typing.

        No `sandbox`: the provider's viewer needs scripts, its own origin and
        its socket, and which tokens it needs cannot be verified without a key.
        A sandbox that silently breaks the view is worse than none — and
        `allow-scripts allow-same-origin`, the least it could run under, takes
        nothing from a cross-origin frame. What would make the frame dangerous
        is its address, so that is what is checked: `src` is only ever an https
        URL (`safeNavigationUrl`, where it is set).
      */}
      <div
        data-testid="browser-frame"
        inert={!interactive}
        tabIndex={interactive ? undefined : -1}
        className={cn("absolute inset-0", !interactive && "pointer-events-none")}
      >
        {live.url ? (
          <iframe
            title={t("The agent's browser")}
            src={live.url}
            allow="autoplay"
            className="h-full w-full border-0 bg-background"
          />
        ) : (
          <div className="grid h-full place-items-center p-4 text-center text-meta text-muted-foreground">
            {placeholder}
          </div>
        )}
      </div>
    </BrowserFrame>
  );
}

/**
 * The browser's box (A13): a 44px bar — the dot, who has it, the task, the
 * one thing to press, open in a window, close — the page filling the middle
 * on the sidebar grey, and a 36px line under it saying what is happening and
 * for how long. Beside a thread it floats: 14px corners, the one card shadow
 * and, while the agent drives, the breathing amber edge.
 */
function BrowserFrame({
  layout,
  live,
  dot,
  status,
  title,
  task,
  action,
  onOpenWindow,
  onClose,
  notices,
  children,
  after,
  footer,
}: {
  layout: "float" | "sheet";
  live: boolean;
  dot: "running" | "waiting" | "done";
  status: string;
  title: string;
  task: string | null;
  action: ReactNode;
  onOpenWindow?: () => void;
  onClose: () => void;
  notices?: ReactNode;
  children: ReactNode;
  after?: ReactNode;
  footer: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden bg-background",
        layout === "float" && "rounded-3xl border border-border shadow-card",
        live && "browser-live",
      )}
    >
      <h2 className="sr-only">{t("Browser")}</h2>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline pr-2 pl-3">
        <StatusDot state={dot} />
        <span className="sr-only">{status}</span>
        <span className="shrink-0 text-meta font-medium whitespace-nowrap">{title}</span>
        {task ? (
          <span className="flex h-7 min-w-0 flex-1 items-center rounded-md bg-surface-muted px-2.5 text-xs text-muted-foreground">
            <span className="truncate">{task}</span>
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {action}
        {onOpenWindow && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("Open in new window")}
            className="text-muted-foreground"
            onClick={onOpenWindow}
          >
            <ExternalLink />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("Close the browser")}
          className="text-muted-foreground"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      {notices && (
        <div className="flex flex-col gap-3 border-b border-hairline p-3 empty:hidden">
          {notices}
        </div>
      )}
      <div className="relative min-h-[240px] flex-1 bg-surface-muted">{children}</div>
      {after}
      <div className="flex h-9 shrink-0 items-center gap-3 border-t border-hairline px-3 text-xs whitespace-nowrap text-muted-foreground">
        {footer}
      </div>
    </div>
  );
}

/** "0:42": how long the task has been going, by the second. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <span className="ml-auto text-foreground tabular-nums">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

/** How often the countdown redraws. A second, because it shows seconds. */
const TICK_MS = 1_000;

/**
 * The person's own browser in the panel, or the offer of one (Task 3.1).
 *
 * What it is for: signing in to sites ahead of time, so the agent's browser —
 * which carries the same profile — finds the person signed in. It is the
 * existing task-less takeover (ruling R43): `POST /browser/takeovers` with no
 * task rents it, `POST …/close` is Done, and Done is what saves the sign-ins,
 * because stopping the browser is what writes the profile (*"always stop the
 * session to persist profile state"*). **Nothing is rented until Open browser
 * is pressed** — the header control only opens this panel.
 *
 * In the person's hands from the first moment, so the frame is live and not
 * `inert`; there is no agent here to keep the controls from. The edge does not
 * breathe — DESIGN.md keeps the amber hairline for an agent's run in progress
 * — and the status chip is the filled square, the panel's own "this one is
 * yours". The takeover has a window (`expiresAt`, ten minutes) and the panel
 * counts it down rather than letting it lapse unannounced; past it, Done still
 * saves, and the sweep stops a browser nobody closed.
 *
 * Not a mutation's state, deliberately: `useMutation` keeps what it resolved
 * with in the mutation cache, and what `open` resolves with is the credential.
 */
function OwnBrowserView({
  own,
  onChange,
  onHide,
  layout,
  notice,
}: {
  own: OwnBrowser | null;
  onChange: (next: OwnBrowser | null) => void;
  onHide: () => void;
  layout: "float" | "sheet";
  /** A refusal the conversation's view was showing when this one took over. */
  notice: string | null;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"opening" | "closing" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Only while something is counting down.
  useEffect(() => {
    if (!own) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [own]);

  async function open() {
    setBusy("opening");
    setProblem(null);
    setNote(null);
    try {
      const opened = await api.takeovers.open();
      if (!alive.current) return;
      setNow(Date.now());
      onChange({
        id: opened.id,
        liveUrl: safeNavigationUrl(opened.liveUrl),
        expiresAt: opened.expiresAt,
      });
    } catch (err) {
      if (!alive.current) return;
      /**
       * 409 is a sentence worth reading: a conversation's browser is in use,
       * or a browser of the person's is already open. That second one may be
       * this panel's to show — opened in another tab after this one mounted
       * (M4) — so the panel asks which is open, as the mount does, and adopts
       * it when it has no task. A task's stays the transcript card's (R43),
       * and then, or when the ask fails, the sentence is the answer.
       */
      if (err instanceof ApiError && err.status === 409) {
        const already = await api.takeovers.current().then(
          ({ takeover }) => (takeover && !takeover.browserTaskId ? takeover : null),
          () => null,
        );
        if (!alive.current) return;
        if (already) {
          setNow(Date.now());
          onChange({
            id: already.id,
            liveUrl: safeNavigationUrl(already.liveUrl),
            expiresAt: already.expiresAt,
          });
          return;
        }
      }
      setProblem(sentence(messageOf(err, t), locale));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  /** Done: stop the browser, which saves the sign-ins. Can take a few seconds. */
  async function done(thenHide: boolean) {
    if (!own) return;
    setBusy("closing");
    setProblem(null);
    try {
      const closed = await api.takeovers.close(own.id);
      void queryClient.invalidateQueries({ queryKey: ["browser-profile"] });
      if (!alive.current) return;
      onChange(null);
      setNote(sentence(closed.message, locale));
      if (thenHide) onHide();
    } catch (err) {
      if (!alive.current) return;
      // Already closed — the sweep stopped it after its window, another tab
      // pressed Done, or a new Open browser closed the lapsed one. Nothing is
      // left to close, so the panel says so and lets go. And the sign-ins are
      // kept, which is worth saying: every one of those paths stops the
      // browser (a refused stop is retried by the sweep), and the stop is what
      // saves the jar.
      if (err instanceof ApiError && err.status === 409) {
        onChange(null);
        setNote(t("This browser has already been closed, and your sign-ins were saved."));
        if (thenHide) onHide();
      } else {
        setProblem(sentence(messageOf(err, t), locale));
      }
    } finally {
      if (alive.current) {
        setBusy(null);
        setConfirmingClose(false);
      }
    }
  }

  /** The same browser in a tab of its own, for a site that will not sign in inside a frame. */
  function openWindow() {
    if (!own) return;
    const { id, liveUrl } = own;
    setProblem(null);
    openInNewWindow(async () => {
      if (liveUrl) return liveUrl;
      const { takeover } = await api.takeovers.current();
      if (!takeover?.liveUrl || takeover.id !== id) throw new Error(t("This browser has closed."));
      return takeover.liveUrl;
    }, t).catch((err: unknown) => setProblem(messageOf(err, t)));
  }

  function close() {
    if (!own) {
      onHide();
      return;
    }
    setConfirmingClose(true);
  }

  const left = own ? new Date(own.expiresAt).getTime() - now : 0;
  // Past the window, no more urgent than is true (ruling R49): the browser
  // is still open and still the person's, and if nobody presses Done the
  // sweep stops it within a few minutes — and that stop saves the jar too.
  const clock =
    left > 0
      ? t("{{time}} left — press Done to save your sign-ins.", {
          time: `${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1_000)).padStart(2, "0")}`,
        })
      : t(
          "Time is up. Press Done to finish; if you don't, it closes by itself shortly and your sign-ins are still saved.",
        );

  return (
    <BrowserFrame
      layout={layout}
      live={false}
      dot={own ? "waiting" : "done"}
      status={own ? t("You are driving") : t("Nobody is driving")}
      title={own ? t("Your browser") : t("Browser")}
      task={null}
      action={
        own ? (
          <Button size="sm" disabled={busy !== null} onClick={() => void done(false)}>
            {busy === "closing" ? t("Saving…") : t("Done")}
          </Button>
        ) : null
      }
      onOpenWindow={own ? openWindow : undefined}
      onClose={close}
      footer={
        own ? (
          <>
            <span>{t("You are using the browser")}</span>
            <span className="ml-auto font-mono tabular-nums">{clock}</span>
          </>
        ) : (
          <span>{t("It stays open for ten minutes. Press Done to save your sign-ins.")}</span>
        )
      }
      notices={
        <>
          {confirmingClose && own && (
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-sm">
                {t("Close the browser? Closing it saves your sign-ins to your profile.")}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingClose(false)}>
                {t("Keep it open")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy !== null}
                onClick={() => void done(true)}
              >
                {t("Close it")}
              </Button>
            </div>
          )}
          {note && !own && (
            <p role="status" className="text-meta text-muted-foreground">
              {note}
            </p>
          )}
          {/* The carried notice only until something newer has been said. */}
          {(problem ?? (own || note ? null : notice)) && (
            <p role="alert" className="text-meta text-destructive">
              {problem ?? notice}
            </p>
          )}
        </>
      }
    >
      {own ? (
        <div data-testid="browser-frame" className="absolute inset-0">
          {own.liveUrl ? (
            <iframe
              title={t("Your browser")}
              src={own.liveUrl}
              allow="autoplay"
              className="h-full w-full border-0 bg-background"
            />
          ) : (
            <div className="grid h-full place-items-center p-4 text-center text-meta text-muted-foreground">
              {t("The browser has no view to show yet. Open it in a new window instead.")}
            </div>
          )}
        </div>
      ) : (
        <div className="absolute inset-0 grid place-items-center p-6 text-center">
          <div className="flex max-w-xs flex-col items-center gap-3">
            <p className="text-sm">
              {t("Sign in to sites ahead of time, so the agent's browser finds you signed in.")}
            </p>
            <Button size="sm" disabled={busy !== null} onClick={() => void open()}>
              {busy === "opening" ? t("Opening…") : t("Open browser")}
            </Button>
          </div>
        </div>
      )}
    </BrowserFrame>
  );
}

/**
 * Who has the controls, said in the line under the page, and the one button
 * that changes it, in the bar over it.
 */
function pillOf({
  mode,
  ready,
  signIn,
  takeOverState,
  donePending,
  continuable,
  onTakeOver,
  onDone,
  onClose,
  t,
}: {
  mode: "agent" | "human" | "cancelling" | "idle";
  ready: boolean;
  signIn: boolean;
  takeOverState: "idle" | "trying" | "gave-up";
  donePending: boolean;
  /** Whether Done has a task to continue; without one it could only answer 409. */
  continuable: boolean;
  onTakeOver: () => void;
  onDone: () => void;
  onClose: () => void;
  t: TFunction;
}): { text: ReactNode; action: ReactNode } {
  if (mode === "human") {
    return {
      text: t("You're driving"),
      // Done continues a task; with none to continue (the newest finished, or
      // is already the retry) the person's one real move is to close the
      // browser, which saves what they did in it.
      action: continuable ? (
        <Button size="sm" disabled={donePending} onClick={onDone}>
          {t("Done")}
        </Button>
      ) : (
        <Button size="sm" onClick={onClose}>
          {t("Close")}
        </Button>
      ),
    };
  }
  if (mode === "cancelling") {
    return takeOverState === "gave-up"
      ? {
          text: t("The agent has not let go yet"),
          action: (
            <Button variant="secondary" size="sm" onClick={onTakeOver}>
              {t("Try again")}
            </Button>
          ),
        }
      : {
          text: t("Waiting for the agent to stop…"),
          action: (
            <Button variant="secondary" size="sm" disabled>
              {t("Take over")}
            </Button>
          ),
        };
  }
  if (!ready && mode === "agent") return { text: t("Starting the browser…"), action: null };
  if (mode === "agent") {
    return {
      text: t("Agent is using the browser"),
      action: (
        <Button variant="secondary" size="sm" onClick={onTakeOver}>
          {t("Take over")}
        </Button>
      ),
    };
  }
  // Nobody driving. `agent` with no run lands here too: saying the agent is
  // using the browser would be false, and take-over is idempotent. At a
  // sign-in wall, taking over is the whole of what to do next, so it is the
  // primary button.
  return {
    text: signIn ? t("Waiting for you to sign in") : t("The agent is not using the browser"),
    action: (
      <Button variant={signIn ? "default" : "secondary"} size="sm" onClick={onTakeOver}>
        {t("Take over")}
      </Button>
    ),
  };
}
