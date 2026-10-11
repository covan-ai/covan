import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type BrowserEventLine,
  type BrowserTask,
  type ConversationBrowser,
} from "@/lib/api-client";

/**
 * What the chat screen and the browser panel both read about the browser
 * beside a conversation — the poll, and the rules over it.
 *
 * A module of its own, rather than exports beside the panel, so the panel file
 * exports components only and Fast Refresh keeps working on it.
 */

/** How often the panel asks while something is happening. */
export const POLL_MS = 3_000;
/** How many of the agent's lines stay on screen. The server sends at most eight per poll. */
const EVENTS_KEPT = 8;

export const browserKey = (sessionId: string | undefined) => ["browser-tasks", sessionId] as const;

/**
 * A v4 run that has not ended — the only kind the panel watches.
 *
 * A v2 task drained from before 0078 is the cron's: the live endpoint polls
 * v4 runs only, it has no browser beside the conversation, and its sign-in is
 * the legacy card's. Counting it here would poll for nothing and open a panel
 * with no browser in it.
 */
export function isRunning(task: BrowserTask): boolean {
  return task.apiVersion === "v4" && (task.status === "queued" || task.status === "running");
}

/**
 * A task that ran: not one waiting its turn in the browser's line (0080), and
 * not one that left the line without starting (`stop_reason = 'not_started'`).
 * The rules below are about what the browser last did, and a task that never
 * reached it did nothing there.
 */
export function ran(task: BrowserTask): boolean {
  return task.status !== "waiting" && task.stopReason !== "not_started";
}

/** The tasks waiting their turn in this browser, oldest first: next in line first. */
export function waitingFor(data: ConversationBrowser | undefined): BrowserTask[] {
  const session = data?.session;
  if (!session) return [];
  return data.tasks
    .filter((t) => t.status === "waiting" && t.browserSessionId === session.id)
    .reverse();
}

/**
 * Whether the next ask is worth a provider call.
 *
 * A run queued or running, or a browser somebody holds — the agent, or the
 * person, whose browser the sweep will stop if they wander off. Anything else
 * is a browser nobody is using, and a tick every three seconds against it is a
 * provider call per tick for nothing.
 */
export function shouldPoll(data: ConversationBrowser | undefined): boolean {
  if (!data) return false;
  return (
    data.tasks.some(isRunning) ||
    // A task waiting its turn starts by itself, and the panel should see it
    // start. Cheap to ask: with nothing running the server makes no provider
    // call.
    data.tasks.some((t) => t.status === "waiting") ||
    (!!data.session && data.session.liveState !== "none")
  );
}

/**
 * The newest task, if it stopped at a login wall the person can sign through.
 *
 * Keyed on the run's own word, `stop_reason = 'login_required'`, which settle
 * writes in its claim (ruling R18). `failed` with no `error` was not enough:
 * a block and a run that did not complete but returned text look the same,
 * and "needs you to sign in" over either sends somebody to do the wrong thing.
 * The host is optional — with one the prompt names the site, without one it
 * says "This site".
 *
 * And the same rules `POST …/hand-back` enforces, so the prompt never asks for
 * a Done that would answer 409: a v4 run, in this browser, that failed, and
 * that is not itself the retry — one free retry per original, ever, and it is
 * the operator's money. Only the newest task is asked about, because the
 * hand-back continues the newest task and nothing else.
 *
 * And only while the browser is still there (final-review I2): a confirmed
 * stop — the sweep's, ten minutes after the last run, or a close — clears the
 * browser the row names, so `browserReady` false with the newest task failed
 * (nothing running) is a browser known stopped. A prompt over it would send
 * somebody to Take over, which can only answer that the browser has closed.
 */
export function signInFor(data: ConversationBrowser | undefined): BrowserTask | null {
  const newest = data?.tasks.find(ran);
  const session = data?.session;
  if (!newest || !session || !session.browserReady) return null;
  return newest.status === "failed" &&
    newest.stopReason === "login_required" &&
    newest.apiVersion === "v4" &&
    newest.browserSessionId === session.id &&
    newest.retryOf == null
    ? newest
    : null;
}

/**
 * Whether Done has anything to continue: the rules `POST …/hand-back`
 * enforces, read off the same rows, so human mode never offers a Done that
 * can only answer 409. The newest task in this browser, a v4 run that is not
 * itself the retry, that failed (a wall) or that the person took over mid-way.
 * A newer task than it would be its successor, so the newest has none.
 */
export function canContinue(data: ConversationBrowser | undefined): boolean {
  const session = data?.session;
  if (!session) return false;
  const newest = data.tasks.find((t) => t.browserSessionId === session.id && ran(t));
  if (!newest || newest.apiVersion !== "v4" || newest.retryOf != null) return false;
  return (
    newest.status === "failed" ||
    (newest.status === "stopped" && newest.stopReason === "handed_to_person")
  );
}

/**
 * What the agent did, across polls.
 *
 * Each answer carries only the events since the last one — the server advances
 * a cursor — so a list drawn from one answer would empty itself every quiet
 * tick. Two open tabs can be handed the same delta, hence the de-duplication.
 */
function keepEvents(prior: BrowserEventLine[], next: BrowserEventLine[]): BrowserEventLine[] {
  const seen = new Set(prior.map(eventId));
  return [...prior, ...next.filter((e) => !seen.has(eventId(e)))].slice(-EVENTS_KEPT);
}

export function eventId(e: BrowserEventLine): string {
  return `${e.ts}\u0000${e.type}\u0000${e.text}`;
}

/**
 * The one poll, shared: the chat screen asks it whether to open the panel and
 * the panel draws from it, under one key, so there is one request per tick.
 */
export function useConversationBrowser(sessionId: string | undefined) {
  const queryClient = useQueryClient();
  /**
   * Ruling R21: in human mode the poll is also the heartbeat that keeps the
   * person's browser from being swept — the server moves `human_since` to now
   * about once a minute while it is being asked. "Open in new window" is
   * exactly the path that puts this tab in the background, where a query
   * stops polling by default, so the browser would be stopped under the
   * person ten minutes into a sign-in. Read from the cache each render rather
   * than from the query's own answer, which this option has to be given before.
   */
  const humanMode =
    queryClient.getQueryData<ConversationBrowser>(browserKey(sessionId))?.session?.liveState ===
    "human";
  return useQuery({
    refetchIntervalInBackground: humanMode,
    queryKey: browserKey(sessionId),
    queryFn: async (): Promise<ConversationBrowser> => {
      const next = await api.sessions.browserTasks(sessionId!);
      // This ask settled a run and wrote its answer: fetch the conversation
      // now rather than leave a private chat — which opens no realtime
      // channel — waiting for a reload to show it.
      if (next.delivered) {
        void queryClient.invalidateQueries({ queryKey: ["messages", sessionId] });
      }
      const prior = queryClient.getQueryData<ConversationBrowser>(browserKey(sessionId));
      return { ...next, events: keepEvents(prior?.events ?? [], next.events) };
    },
    enabled: !!sessionId,
    refetchInterval: (query) => (shouldPoll(query.state.data) ? POLL_MS : false),
  });
}

type View = {
  sessionId: string | undefined;
  /** `shown` by the person; `latched` when it opened by itself, and stays. */
  mode: "auto" | "shown" | "latched" | "hidden";
  /** The newest task when the person hid the panel: a newer one opens it again. */
  dismissed: string | null;
};

/**
 * Whether the chat screen shows the panel, and the header control's two verbs.
 *
 * It opens by itself while there is something to watch or a sign-in to do,
 * and a person who closes it has said so about THIS task — the next one the
 * agent starts opens it again. Below `lg` it never opens by itself: there it
 * is a full-height sheet over the conversation, and a sheet that slides over
 * what somebody is reading because a run started is a sheet that gets in the
 * way. The header control opens it there.
 *
 * The view is remembered per conversation by naming the conversation in the
 * state, rather than reset by an effect when it changes.
 */
export function useBrowserPanel(sessionId: string | undefined, narrow: boolean) {
  const { data } = useConversationBrowser(sessionId);
  const [view, setView] = useState<View>({ sessionId, mode: "auto", dismissed: null });
  const current: View =
    view.sessionId === sessionId ? view : { sessionId, mode: "auto", dismissed: null };

  const newest = data?.tasks[0]?.id ?? null;
  const wanted = shouldPoll(data) || !!signInFor(data);
  const dismissed = current.mode === "hidden" && current.dismissed === newest;
  const opensByItself = !narrow && wanted && !dismissed;
  // Once it has opened by itself it stays until the person closes it: the
  // run finishing ends `wanted`, but the browser is still there, idle, with
  // the page the agent just read (found in the end-to-end run). Set during
  // render, the way React keeps state derived from earlier renders. `latched`
  // rather than `shown`, so a window narrowed below `lg` afterwards still
  // does not get a sheet it never asked for.
  if (sessionId && opensByItself && current.mode !== "shown" && current.mode !== "latched") {
    setView({ sessionId, mode: "latched", dismissed: null });
  }
  const open =
    !!sessionId &&
    (current.mode === "shown" || (current.mode === "latched" && !narrow) || opensByItself);

  return {
    /** A browser exists beside this conversation, so the header control is worth showing. */
    available: !!data?.session,
    open,
    /** The agent is driving right now — the header control's mark while the panel is shut. */
    driving: !!data?.session && data.session.liveState === "agent" && data.tasks.some(isRunning),
    /**
     * A sign-in is waiting on the person — the header control's filled square.
     * On a phone the sheet never opens by itself and the prompt is inside it,
     * so without this a login wall would have no cue at all.
     */
    signIn: !!signInFor(data),
    show: () => setView({ sessionId, mode: "shown", dismissed: null }),
    hide: () => setView({ sessionId, mode: "hidden", dismissed: newest }),
  };
}

/**
 * Open the live view in a tab of its own: reserved on the click, navigated
 * when the address arrives.
 *
 * Safari blocks a `window.open` that is not a direct consequence of a gesture,
 * and the address may not exist until a request has come back — so the tab is
 * opened synchronously, empty, and sent somewhere afterwards. Call this from
 * the click handler itself: everything before the first `await` runs inside
 * the gesture. `useConnectComposio` (`use-connections.ts`) faced the same
 * constraint and answered it with a full page navigation; that is not
 * available here, because the Covan tab has to stay open to carry Done.
 *
 * `opener` is nulled rather than passed as `noopener`, because `noopener`
 * makes `window.open` return null and there would be nothing left to navigate.
 *
 * The address is a credential — *"Treat the URL as a credential"* — so it goes
 * into the tab's address bar and nowhere else: not a link on the page, not a
 * toast, and not this function's error messages.
 */
export async function openInNewWindow(mint: () => Promise<string>): Promise<void> {
  const tab = window.open("", "_blank");
  try {
    const url = await mint();
    if (!tab || tab.closed) {
      throw new Error(
        "Your browser blocked the new window. Allow pop-ups for Covan and try again.",
      );
    }
    tab.opener = null;
    tab.location.replace(url);
  } catch (err) {
    tab?.close();
    throw err;
  }
}
