import type { SupabaseClient } from "@supabase/supabase-js";
import type { Context } from "hono";
import { deferred } from "../defer";

/**
 * Events around a turn, for an operator's build to observe. Nothing here acts
 * on them.
 *
 * The open build registers no observer, so `observeTurn` does nothing. An
 * operator's build registers observers from its own entry point, the way it
 * registers entitlements (`lib/entitlements`).
 *
 * Observers are started together and handed to `deferred`, not awaited by the
 * request. They get the caller's own client, and so the caller's own
 * permissions. Whatever one throws is logged and dropped.
 */

export type TurnEvent =
  | {
      /**
       * An ordinary question, before it is answered. Editing a question and
       * sending it again gives `question_edited` (from the edit) and then
       * `question_asked` for the same `messageId`, with `at` the row's
       * original `created_at`.
       */
      kind: "question_asked";
      workspaceId: string;
      userId: string;
      agentId: string;
      sessionId: string;
      messageId: string;
      content: string;
      /** Who typed it: the row's `sender_id`, null on a row from before senders were recorded. */
      senderId: string | null;
      /** ISO. When the question row was created. */
      at: string;
      /**
       * The question before this one, who typed it and when its reply was
       * written, or null.
       */
      previous: {
        messageId: string;
        content: string;
        senderId: string | null;
        repliedAt: string;
      } | null;
    }
  | {
      /** A reply is being asked for again. */
      kind: "reply_regenerated";
      workspaceId: string;
      userId: string;
      agentId: string;
      sessionId: string;
      /** The reply being replaced. */
      messageId: string | null;
      /** The model that will answer this time. */
      model: string | null;
    }
  | {
      /** The text of a question was changed after it was sent. */
      kind: "question_edited";
      workspaceId: string;
      userId: string;
      agentId: string | null;
      sessionId: string;
      messageId: string;
    };

export type TurnObserver = (event: TurnEvent, db: SupabaseClient) => Promise<void> | void;

const observers: TurnObserver[] = [];

/** Called by an operator's entry point, once, at start-up. */
export function registerTurnObserver(observer: TurnObserver): void {
  observers.push(observer);
}

/** Whether anything is registered, for a caller that would read something just to describe an event. */
export function hasTurnObservers(): boolean {
  return observers.length > 0;
}

/** For tests. */
export function forgetTurnObservers(): void {
  observers.length = 0;
}

/**
 * Tell every registered observer. Returns at once; with nothing registered it
 * does nothing at all.
 *
 * A function stands for an event that takes a read to describe: it is called
 * with the observers' work, not by the request, and returning null drops the
 * event.
 */
export function observeTurn(
  c: Context,
  event: TurnEvent | (() => Promise<TurnEvent | null> | TurnEvent | null),
): void {
  if (observers.length === 0) return;
  const db = c.get("db") as SupabaseClient;
  const run = async (observer: TurnObserver, told: TurnEvent) => {
    try {
      await observer(told, db);
    } catch (err) {
      console.error("turn observer failed", err);
    }
  };
  const work = async () => {
    let told: TurnEvent | null;
    try {
      told = typeof event === "function" ? await event() : event;
    } catch (err) {
      console.error("turn event failed", err);
      return;
    }
    if (told) await Promise.all(observers.map((o) => run(o, told)));
  };
  deferred(c, work());
}
