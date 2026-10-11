import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Lock, X } from "lucide-react";
import {
  api,
  type ConversationBrowser,
  type LiveState,
  type TakeOverResult,
} from "@/lib/api-client";
import { ApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { HeaderAction } from "@/components/chat/turn-actions";
import { cn } from "@/lib/utils";
import { SignInPrompt } from "./takeover-card";
import {
  browserKey,
  canContinue,
  eventId,
  isRunning,
  openInNewWindow,
  signInFor,
  useConversationBrowser,
} from "./use-conversation-browser";

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

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Something went wrong.";
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const GAVE_UP = "The agent has not let go of the browser yet. Try again in a moment.";

export function BrowserPanel({
  sessionId,
  onHide,
  layout = "side",
}: {
  sessionId: string;
  onHide: () => void;
  /** `side` beside the chat at `lg` and up; `sheet` full-height below it. */
  layout?: "side" | "sheet";
}) {
  const queryClient = useQueryClient();
  const { data, dataUpdatedAt } = useConversationBrowser(sessionId);
  const session = data?.session ?? null;
  const running = (data?.tasks ?? []).some(isRunning);
  const prompt = signInFor(data);
  const continuable = canContinue(data);
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
  const newestTask = data?.tasks[0]?.id ?? null;
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
        if (current) setLive({ url: minted.liveUrl, problem: null });
      },
      (err: unknown) => {
        if (!current) return;
        // 409 is "no browser is running yet" — the run is still starting it.
        const notYet = err instanceof ApiError && err.status === 409;
        setLive({ url: null, problem: notYet ? null : messageOf(err) });
      },
    );
    return () => {
      current = false;
    };
    // `browserReady` and the newest task are triggers, not inputs: each is a
    // moment the browser on screen may no longer be the browser there is.
  }, [browserId, browserReady, mints, newestTask]);

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
      setProblem(messageOf(err));
      // A 409 here is usually a browser that has closed (final-review I2); the
      // server has forgotten it, and asking now drops the sign-in prompt
      // rather than leaving it pointing at nothing until the next poll.
      void queryClient.invalidateQueries({ queryKey: browserKey(sessionId) });
    },
  });

  const handBack = useMutation({
    mutationFn: (id: string) => api.browser.handBack(id),
    onMutate: () => setProblem(null),
    onSuccess: () => {
      // Inert again before the next poll: a run has just been started in this
      // browser, and the frame must not stay in the person's hands under it.
      patchLiveState("agent", null);
      void queryClient.invalidateQueries({ queryKey: browserKey(sessionId) });
    },
    // A 409 is a sentence worth reading — "already tried again", "nothing to
    // continue" — so it goes beside the button rather than into a toast.
    onError: (err) => setProblem(messageOf(err)),
  });

  const stop = useMutation({
    mutationFn: (id: string) => api.browser.stop(id),
    onMutate: () => setProblem(null),
    onSuccess: () => {
      setConfirmingClose(false);
      setLive({ url: null, problem: null });
      patchLiveState("none", null);
      void queryClient.invalidateQueries({ queryKey: browserKey(sessionId) });
      onHide();
    },
    onError: (err) => setProblem(messageOf(err)),
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
   * sign-ins are kept.
   */
  function close() {
    if (!session || running) {
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
        if (result.liveState !== "human") throw new Error(GAVE_UP);
      }
      return (await api.browser.live(id)).liveUrl;
    }).catch((err: unknown) => setProblem(messageOf(err)));
  }

  const status =
    mode === "agent" || mode === "cancelling"
      ? "The agent is driving"
      : mode === "human"
        ? "You are driving"
        : "Nobody is driving";
  const placeholder = live.problem
    ? live.problem
    : session && (running || liveState !== "none")
      ? "Starting the browser…"
      : "No browser is open right now.";

  return (
    <div
      className={cn(
        "relative flex h-full flex-col bg-background",
        layout === "side" && "border-l border-border",
        hairline && "browser-live",
      )}
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        {/* The status chip. The running square while the agent drives (an
            amber outline, the machine busy), a filled amber square while the
            person does (this one is yours), neutral otherwise — the same two
            ambers `.step-running` in styles.css keeps apart. */}
        <span
          aria-hidden="true"
          className={cn(
            "h-2 w-2 shrink-0 rounded-[2px]",
            mode === "agent" || mode === "cancelling"
              ? "step-running"
              : mode === "human"
                ? "bg-accent-orange"
                : "bg-muted-foreground/40",
          )}
        />
        <span className="sr-only">{status}</span>
        <h2 className="min-w-0 flex-1 truncate font-dm text-title font-medium">Browser</h2>
        <div className="flex shrink-0 items-center gap-0.5">
          {session && (
            <HeaderAction label="Open in new window" onClick={() => openWindow(false)}>
              <ExternalLink className="h-4 w-4" />
            </HeaderAction>
          )}
          <HeaderAction label="Close the browser" onClick={close}>
            <X className="h-4 w-4" />
          </HeaderAction>
        </div>
      </div>

      {confirmingClose && session && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          <span className="min-w-0 flex-1 text-sm">
            Close the browser? Closing it saves your sign-ins to your profile.
          </span>
          <Button variant="ghost" size="sm" onClick={() => setConfirmingClose(false)}>
            Keep it open
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={stop.isPending}
            onClick={() => stop.mutate(session.id)}
          >
            Close it
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {prompt && (
          <SignInPrompt
            host={prompt.signInHost}
            opening={takeOver.isPending}
            onOpenWindow={() => openWindow(true)}
          />
        )}

        <div
          className={cn(
            "flex w-full justify-center",
            layout === "side" && "min-h-0 flex-1 items-center",
          )}
        >
          {/*
            The frame, letterboxed on the canvas rather than on black.

            Inert, untabbable and deaf to the pointer while anybody but the
            person has the controls — and that is a courtesy, not a lock.
            browser-use says so outright: *"View-only embeds are a UI
            restriction, not a server-enforced permission."* Whoever holds the
            URL can drive the browser, which is why the URL is the thing kept
            close (*"Treat the URL as a credential"*), and why this wrapper only
            stops a stray click from landing in the middle of the agent's typing.

            No `sandbox`: the provider's viewer needs scripts, its own origin
            and its socket, and which tokens it needs cannot be verified without
            a key. A sandbox that silently breaks the view is worse than none.
          */}
          <div
            data-testid="browser-frame"
            inert={!interactive}
            tabIndex={interactive ? undefined : -1}
            className={cn(
              "aspect-video w-full overflow-hidden rounded-xl border border-border bg-background",
              !interactive && "pointer-events-none",
            )}
          >
            {live.url ? (
              <iframe
                title="The agent's browser"
                src={live.url}
                allow="autoplay"
                className="h-full w-full border-0"
              />
            ) : (
              <div className="grid h-full place-items-center p-4 text-center text-meta text-muted-foreground">
                {placeholder}
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-center">
          <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-card py-1 pl-3 pr-1 text-sm">
            <Pill
              mode={mode}
              ready={browserReady || !!live.url}
              signIn={!!prompt}
              takeOverState={takeOverState}
              donePending={handBack.isPending}
              continuable={continuable}
              onTakeOver={() => session && takeOver.mutate(session.id)}
              onDone={() => session && handBack.mutate(session.id)}
              onClose={close}
            />
          </div>
        </div>

        {/* Ruling R21: the sweep stops a browser about ten minutes after the
            tab holding it goes quiet (this tab's poll is the heartbeat, every
            minute or so). Said beside Done, so walking away is a choice. */}
        {mode === "human" && (
          <p className="text-center text-meta text-muted-foreground">
            The browser closes about ten minutes after this tab is closed.
          </p>
        )}

        {problem && (
          <p role="alert" className="text-center text-meta text-destructive">
            {problem}
          </p>
        )}

        {data && data.events.length > 0 && (
          <ol className="flex flex-col gap-1 text-meta text-muted-foreground">
            {data.events.map((e) => (
              <li key={eventId(e)} className="flex items-start gap-2">
                <span
                  aria-hidden="true"
                  className="mt-[0.5em] h-1.5 w-1.5 shrink-0 rounded-[1px] bg-muted-foreground/50"
                />
                {/* The provider publishes no event catalogue, so a line with
                    nothing to say shows its type rather than vanishing. */}
                <span className="min-w-0 [overflow-wrap:anywhere]">{e.text || e.type}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/** What the pill says, by who has the controls. Its one button is the panel's main action. */
function Pill({
  mode,
  ready,
  signIn,
  takeOverState,
  donePending,
  continuable,
  onTakeOver,
  onDone,
  onClose,
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
}) {
  const lock = <Lock aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;

  if (mode === "human") {
    return (
      <>
        <span>You&apos;re driving</span>
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        {/* Done continues a task; with none to continue (the newest finished,
            or is already the retry) the person's one real move is to close
            the browser, which saves what they did in it. */}
        {continuable ? (
          <Button size="sm" disabled={donePending} onClick={onDone}>
            Done
          </Button>
        ) : (
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        )}
      </>
    );
  }
  if (mode === "cancelling") {
    return takeOverState === "gave-up" ? (
      <>
        {lock}
        <span>The agent has not let go yet</span>
        <Button variant="outline" size="sm" onClick={onTakeOver}>
          Try again
        </Button>
      </>
    ) : (
      <>
        {lock}
        <span>Waiting for the agent to stop…</span>
        <Button variant="outline" size="sm" disabled>
          Take over
        </Button>
      </>
    );
  }
  if (!ready && mode === "agent") {
    return <span className="pr-2 text-muted-foreground">Starting the browser…</span>;
  }
  if (mode === "agent") {
    return (
      <>
        {lock}
        <span>Agent is using the browser</span>
        <Button variant="outline" size="sm" onClick={onTakeOver}>
          Take over
        </Button>
      </>
    );
  }
  // Nobody driving. `agent` with no run lands here too: saying the agent is
  // using the browser would be false, and take-over is idempotent. At a
  // sign-in wall, taking over is the whole of what to do next, so it is the
  // primary button — ink, per DESIGN.md, not amber.
  return (
    <>
      <span className="text-muted-foreground">
        {signIn ? "Waiting for you to sign in" : "The agent is not using the browser"}
      </span>
      <Button variant={signIn ? "default" : "outline"} size="sm" onClick={onTakeOver}>
        Take over
      </Button>
    </>
  );
}
