import { api, getAccessToken, type OnboardingEvent } from "./api-client";

/**
 * What happened on the way through the first run, kept until it can be sent.
 *
 * First-party only. The events go to our own `POST /onboarding/events` and
 * nowhere else: the privacy page promises no third-party analytics, and this
 * keeps that promise while still answering the one question the first run
 * cannot answer about itself — where people stop.
 *
 * Batched rather than sent per tap, because a run is a few dozen events and
 * each one is a round trip the screen does not need to wait for. The batch is
 * flushed on every step change and when the page goes away. The second case
 * cannot use `sendBeacon`, which carries no Authorization header, so it is a
 * `keepalive` fetch with the last token this module saw.
 */

export type OnboardingEventKind = OnboardingEvent["event"];

/** Past this the queue is not a run, it is a bug; the oldest are dropped. */
const MAX_QUEUE = 100;

let queue: OnboardingEvent[] = [];
/** When each step was last shown, for the elapsed time on its next event. */
const viewedAt = new Map<string, number>();
let cachedToken: string | undefined;
let flushing: Promise<void> | null = null;

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // A browser old enough to lack it is also one this app will not run in, but
  // a queue that cannot mint an id must not throw on the way into a screen.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Record that a step was shown, finished or skipped.
 *
 * The elapsed time on `completed` and `skipped` is measured from the step's
 * last `viewed`; a step finished without having been viewed (not something
 * the screen does, but nothing stops a caller) has none.
 */
export function trackStep(step: string, event: OnboardingEventKind): void {
  const now = Date.now();
  const since = viewedAt.get(step);
  if (event === "viewed") {
    viewedAt.set(step, now);
  }
  const entry: OnboardingEvent = {
    step,
    event,
    at: new Date(now).toISOString(),
    ...(event !== "viewed" && since !== undefined ? { elapsedMs: Math.max(0, now - since) } : {}),
    clientId: newId(),
  };
  queue.push(entry);
  if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE);

  // Keep a token warm for the unload path, which cannot wait for one.
  void getAccessToken()
    .then((token) => {
      cachedToken = token;
    })
    .catch(() => {
      /* the next flush will ask again */
    });
}

/**
 * Send what is queued. Failures are swallowed and the batch is put back once:
 * an analytics event is never worth an error on screen, and never worth
 * growing without bound either.
 */
export function flushEvents(opts: { unloading?: boolean } = {}): Promise<void> {
  if (queue.length === 0) return Promise.resolve();
  if (flushing) return flushing;

  const batch = queue;
  queue = [];

  const send = opts.unloading ? sendKeepalive(batch) : api.onboarding.events(batch);
  flushing = Promise.resolve(send)
    .then(() => undefined)
    .catch(() => {
      // Back on the front, once. A batch that fails twice is dropped by the
      // cap above rather than retried forever.
      if (!batch.some((e) => e.clientId.endsWith("#retried"))) {
        queue = [...batch.map((e) => ({ ...e, clientId: `${e.clientId}#retried` })), ...queue];
      }
    })
    .finally(() => {
      flushing = null;
    });
  return flushing;
}

/**
 * The same request `api.onboarding.events` makes, allowed to outlive the page.
 * `sendBeacon` cannot carry the bearer token; `keepalive` can.
 */
async function sendKeepalive(batch: OnboardingEvent[]): Promise<void> {
  const token = cachedToken ?? (await getAccessToken().catch(() => undefined));
  if (!token) return;
  await fetch(`${import.meta.env.VITE_API_URL}/onboarding/events`, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events: batch.map(stripRetryMark) }),
  });
}

function stripRetryMark(e: OnboardingEvent): OnboardingEvent {
  return e.clientId.endsWith("#retried")
    ? { ...e, clientId: e.clientId.slice(0, -"#retried".length) }
    : e;
}

/**
 * Flush when the page is going away. `pagehide` is the reliable one on phones;
 * `visibilitychange` to hidden catches a tab switched away from and never
 * returned to. Returns the uninstaller, for an effect's cleanup.
 */
export function installUnloadFlush(): () => void {
  const onHide = () => {
    void flushEvents({ unloading: true });
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") onHide();
  };
  window.addEventListener("pagehide", onHide);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("pagehide", onHide);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** What is waiting to be sent. For tests. */
export function pendingEvents(): readonly OnboardingEvent[] {
  return queue.map(stripRetryMark);
}

/** For tests. */
export function _resetAnalytics(): void {
  queue = [];
  viewedAt.clear();
  cachedToken = undefined;
  flushing = null;
}
