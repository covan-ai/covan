import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type BrowserTask, type Takeover } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

/**
 * The offer to sign in yourself, and the browser you do it in.
 *
 * A browser task that stopped at a login wall is recoverable: Covan rents a
 * real browser, hands you its address, and you sign in **in your own tab, at
 * the site itself**. Covan never sees the password, never stores one, and is
 * never sent one — which is the whole reason the sign-in happens over there
 * rather than in a form here.
 *
 * **There is deliberately no iframe.** Three reasons, and the first two are
 * enough on their own. A passkey cannot work in one: WebAuthn is origin-bound,
 * so a platform passkey or a security key is simply unreachable from an
 * embedded view. A password manager correctly refuses to fill it, because the
 * origin it can see is the provider's rather than the site's. And the frame is
 * not a security boundary anyway — browser-use says so outright: *"View-only
 * embeds are a UI restriction, not a server-enforced permission. Anyone who
 * opens the live URL directly or uses the underlying CDP URL can still control
 * the browser."* So a new tab, where the browser behaves like a browser.
 */

/** How often the countdown redraws. A second, because it shows seconds. */
const TICK_MS = 1_000;

function remaining(expiresAt: string, now: number): { minutes: number; seconds: number } | null {
  const left = new Date(expiresAt).getTime() - now;
  if (left <= 0) return null;
  return { minutes: Math.floor(left / 60_000), seconds: Math.floor((left % 60_000) / 1_000) };
}

/**
 * The live URL, for the life of this tab and no longer.
 *
 * Held in component state rather than in the query cache on purpose: it is a
 * credential, and a cache is a thing that persists, gets devtools-inspected
 * and gets serialised. A reload loses it, which is what
 * `GET /browser/takeovers/current` exists to recover.
 */
export function TakeoverCard({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient();
  /**
   * What this tab minted, if it minted anything.
   *
   * Separate from what the server reports, and DERIVED together below rather
   * than synced with an effect: copying one into the other would be a second
   * source of truth for the same fact, and a setState inside an effect to keep
   * them level.
   */
  const [minted, setMinted] = useState<Takeover | null>(null);
  /** Set when this tab closed one, so a stale server answer cannot resurrect it. */
  const [closedId, setClosedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const { data } = useQuery({
    queryKey: ["browser-tasks", sessionId],
    queryFn: () => api.sessions.browserTasks(sessionId),
    enabled: !!sessionId,
  });

  /**
   * The reload recovery, and the likeliest day-one failure without it.
   *
   * The live URL exists only in the response that minted it, and a person may
   * hold one open takeover at a time — so a reloaded chat tab would otherwise
   * lock somebody out of their own signed-in browser for the rest of the
   * window, and the waiting is what destroys the login they were part-way
   * through. Chat tabs get reloaded constantly.
   */
  const { data: current } = useQuery({
    queryKey: ["browser-takeover-current"],
    queryFn: () => api.browser.current(),
    enabled: !minted,
    // Not cached across mounts: the URL inside it is a credential, and a stale
    // one points at a browser that has already been stopped.
    gcTime: 0,
    staleTime: 0,
  });

  const fromServer =
    current?.takeover && current.takeover.id !== closedId ? current.takeover : null;
  const takeover = minted ?? fromServer;

  // Only while something is actually counting down.
  useEffect(() => {
    if (!takeover) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [takeover]);

  /**
   * A tab reserved on the click, navigated when the address arrives.
   *
   * Safari blocks a `window.open` that is not a direct consequence of a
   * gesture, and the address does not exist until a request has come back — so
   * the tab is opened synchronously, empty, and sent somewhere afterwards.
   * `useConnectComposio` faced the same constraint and answered it with a full
   * page navigation; that is not available here, because the Covan tab has to
   * stay open to carry the countdown and the done button.
   *
   * `opener` is nulled rather than passed as `noopener`, because `noopener`
   * makes `window.open` return null and there would be nothing left to
   * navigate.
   */
  const tabRef = useRef<Window | null>(null);

  const open = useMutation({
    mutationFn: async (browserTaskId: string) => {
      const result = await api.browser.takeOver(browserTaskId);
      if (!result.liveUrl) {
        throw new Error("That browser started but there is no address to open it at.");
      }
      return result;
    },
    onSuccess: (result) => {
      setMinted(result);
      const tab = tabRef.current;
      if (tab && !tab.closed) {
        tab.opener = null;
        tab.location.replace(result.liveUrl!);
      } else {
        // The tab was blocked or closed before the address arrived. The
        // browser is running either way, so the address is offered as a link
        // rather than lost.
        toast.info("Your browser is ready — use the link on the card to open it.");
      }
    },
    onError: (err: Error) => {
      tabRef.current?.close();
      toast.error(err.message);
    },
  });

  const close = useMutation({
    mutationFn: (id: string) => api.browser.close(id),
    onSuccess: async (result, id) => {
      setMinted(null);
      setClosedId(id);
      tabRef.current?.close();
      toast.success(
        result.signedInTo.length > 0
          ? `Signed in to ${result.signedInTo.join(", ")}. ${result.message}`
          : result.message,
      );
      await queryClient.invalidateQueries({ queryKey: ["browser-tasks", sessionId] });
      await queryClient.invalidateQueries({ queryKey: ["messages"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const offer = (data?.tasks ?? []).find(offerable);
  if (takeover) {
    const left = remaining(takeover.expiresAt, now);
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
        <p className="font-medium">Sign in, then press done</p>
        <p className="mt-1 text-muted-foreground">
          The browser opened in a new tab. Sign in there, at the site itself — Covan cannot see what
          you type. <strong>Nothing is saved until you press done below</strong>, so press it even
          if the site looks finished.
        </p>
        {takeover.liveUrl && (
          <p className="mt-2">
            <a
              className="underline"
              href={takeover.liveUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open the browser again
            </a>
          </p>
        )}
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          {left
            ? `${left.minutes}:${String(left.seconds).padStart(2, "0")} left`
            : "the window has closed — press done, or start again"}
        </p>
        <Button
          className="mt-3"
          size="sm"
          disabled={close.isPending}
          onClick={() => close.mutate(takeover.id)}
        >
          {close.isPending ? "Saving your sign-in…" : "Done, I've signed in"}
        </Button>
      </div>
    );
  }

  if (!offer) return null;

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
      <p className="font-medium">That needed a sign-in</p>
      <p className="mt-1 text-muted-foreground">
        The browser could not get past a login. You can sign in yourself in a new tab, and the task
        will run again — no charge for the second attempt. You type your password at the site; Covan
        never receives it.
      </p>
      <Button
        className="mt-3"
        size="sm"
        disabled={open.isPending}
        onClick={() => {
          // Reserved here, inside the gesture, for the reason above.
          tabRef.current = window.open("", "_blank");
          open.mutate(offer.id);
        }}
      >
        {open.isPending ? "Opening a browser…" : "Sign in myself"}
      </Button>
    </div>
  );
}

/**
 * Whether to offer a takeover for this task.
 *
 * The same predicate `routes/browser.ts` enforces, so the card never shows a
 * button that would answer 409. `retryOf == null` is the one that bounds the
 * operator's money: without it, a retry that fails at a second wall is
 * offerable again and the loop is free browser tasks forever.
 */
function offerable(task: BrowserTask): boolean {
  return task.status === "failed" && !!task.output && task.retryOf == null;
}
