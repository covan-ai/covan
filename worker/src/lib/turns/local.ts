import { DetachedTurn, LINGER_MS, type TurnFetch, type TurnStart } from "./detached";

/**
 * The turns this process is running, by conversation.
 *
 * One at a time per conversation, which is what the chat screen already
 * enforces from its side: a second question while the first is still being
 * answered would be answered from a transcript that does not have the first
 * answer in it yet.
 *
 * A finished turn stays here for `LINGER_MS`, so a browser that reconnects in
 * the moment between the turn ending and the reload of its transcript is shown
 * how it ended rather than nothing.
 *
 * Used directly on Node, and from inside the Durable Object on Cloudflare —
 * where "this process" is the one object that owns the conversation.
 */
const bySession = new Map<string, DetachedTurn>();

export type StartResult = { kind: "started"; turn: DetachedTurn } | { kind: "busy" };

export function startLocalTurn(start: TurnStart, fetchApp: TurnFetch): StartResult {
  const current = bySession.get(start.sessionId);
  if (current?.running) return { kind: "busy" };

  const turn = new DetachedTurn(start, fetchApp);
  bySession.set(start.sessionId, turn);
  void turn.finished.then(() => {
    const timer = setTimeout(() => {
      if (bySession.get(start.sessionId) === turn) bySession.delete(start.sessionId);
    }, LINGER_MS);
    // On Node, a finished turn's linger must not be what keeps a stopping
    // process alive for another minute.
    (timer as { unref?: () => void }).unref?.();
  });
  return { kind: "started", turn };
}

/** The conversation's turn: the one running, or the one that just ended. */
export function localTurn(sessionId: string): DetachedTurn | undefined {
  return bySession.get(sessionId);
}

/** Exposed for tests. */
export function resetLocalTurns(): void {
  bySession.clear();
}
