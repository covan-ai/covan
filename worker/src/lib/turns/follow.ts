import type { RoutineEnv } from "../../types";
import { settleConversationBrowser } from "../browser/live";

/**
 * After a turn, keep an eye on the browser it may have started.
 *
 * `browse` hands its work to the provider and the turn ends; the answer is
 * posted later, by whichever clock notices the run has finished. The open tab
 * is one, every three seconds. The cron is the other, every five minutes and
 * behind a four-minute poll interval — and with the tab closed it was the only
 * one, so a two-minute browser task answered seven minutes later and looked,
 * to the person who came back, like one that had stopped.
 *
 * So the turn's host is a third clock, for as long as there is a run in the
 * conversation to follow: the Durable Object chains alarms, Node chains
 * timers. Every turn is followed once, which costs one read when it started no
 * browser; a turn that did is followed until the run ends or `FOLLOW_FOR_MS`
 * passes, by which time the cron has long since taken over.
 */
export const FOLLOW_EVERY_MS = 5_000;
export const FOLLOW_FOR_MS = 30 * 60_000;

export type Follow = { sessionId: string; userId: string; until: number };

export function followFrom(start: { sessionId: string; userId: string }, now = Date.now()): Follow {
  return { sessionId: start.sessionId, userId: start.userId, until: now + FOLLOW_FOR_MS };
}

/** One look. Answers whether to look again. Never throws. */
export async function followOnce(
  env: RoutineEnv,
  follow: Follow,
  now = Date.now(),
): Promise<boolean> {
  try {
    const { running } = await settleConversationBrowser(env, {
      chatSessionId: follow.sessionId,
      userId: follow.userId,
    });
    return running && now < follow.until;
  } catch (err) {
    console.error("could not follow a conversation's browser", err);
    return now < follow.until;
  }
}

/** The Node clock: the same looks, on timers that do not hold the process open. */
export function followLocally(env: RoutineEnv, follow: Follow): void {
  const look = () => {
    void followOnce(env, follow).then((again) => {
      if (!again) return;
      const timer = setTimeout(look, FOLLOW_EVERY_MS);
      (timer as { unref?: () => void }).unref?.();
    });
  };
  const timer = setTimeout(look, FOLLOW_EVERY_MS);
  (timer as { unref?: () => void }).unref?.();
}
