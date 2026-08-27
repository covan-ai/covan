import { useEffect, useState } from "react";
import type { Agent, ChatSession } from "./agents-store";

/**
 * What a new workspace still has left to do.
 *
 * The first run ends with an agent that has read something, and then nothing
 * says what this becomes once it is set up. The four steps below are the ones
 * that decide whether a workspace stays: knowledge in it, an answer out of it,
 * somebody else in the room, and something that runs while nobody is watching.
 *
 * Every fact is read off state the home screen already holds. That is a
 * constraint, not a coincidence — a checklist worth one round trip is worth
 * none, and the alternative is a counters table that has to be kept true.
 */
export type FirstWeekStep = {
  key: "knowledge" | "ask" | "team" | "routine";
  label: string;
  hint: string;
  done: boolean;
};

export type FirstWeekInput = {
  agents: Agent[];
  sessions: ChatSession[];
  /** Everyone in the workspace, including the person reading this. */
  memberCount: number;
  routineCount: number;
};

export function firstWeekSteps({
  agents,
  sessions,
  memberCount,
  routineCount,
}: FirstWeekInput): FirstWeekStep[] {
  return [
    {
      key: "knowledge",
      label: "Upload what the team knows",
      hint: "A process doc, a contract, a research note. This is what the agent answers from.",
      done: agents.some((a) => a.documents.length > 0),
    },
    {
      key: "ask",
      label: "Ask it something the document answers",
      hint: "The reply names the file it came from — that is the difference between this and a chat window.",
      // `messageCount`, not `sessions.length`: opening the composer starts a
      // session before anybody has said anything, so counting sessions would
      // tick this box for a workspace that has never asked a question.
      done: sessions.some((s) => s.messageCount > 0),
    },
    {
      key: "team",
      label: "Bring in a teammate",
      hint: "They get the same agent, and their own conversations with it stay private.",
      // Membership, not a pending invitation. "Invited somebody" is a fact the
      // Team page already reports; this asks whether anyone actually arrived,
      // which is the thing an invitation that never reached anybody looks
      // exactly like.
      done: memberCount > 1,
    },
    {
      key: "routine",
      label: "Schedule something that runs without you",
      hint: "Point one at a feed or a page, say what to do with it, and the result arrives by email or Slack.",
      done: routineCount > 0,
    },
  ];
}

/** Nothing to nag about once they are all done. */
export function firstWeekRemaining(steps: FirstWeekStep[]): number {
  return steps.filter((s) => !s.done).length;
}

/**
 * Dismissal, remembered per workspace — a second workspace is a second setup,
 * and being told once about this one should not silence the next.
 *
 * The read is in an effect rather than a lazy initialiser because the workspace
 * id arrives from `api.me()` a beat after the first render: an initialiser
 * would run against `undefined` and never look again, so a dismissed checklist
 * would come back on every load. It also keeps the server render out of
 * `localStorage`, which does not exist there.
 *
 * Storage can throw — private mode, quota — and the answer is a checklist that
 * shows up again, which is the harmless direction.
 */
export function useChecklistDismissed(workspaceId: string | undefined) {
  const key = workspaceId ? `covan:first-week-dismissed:${workspaceId}` : null;
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!key) return;
    try {
      setDismissed(window.localStorage.getItem(key) === "1");
    } catch {
      setDismissed(false);
    }
  }, [key]);

  const dismiss = () => {
    setDismissed(true);
    if (!key) return;
    try {
      window.localStorage.setItem(key, "1");
    } catch {
      /* back next reload; see above */
    }
  };

  return { dismissed, dismiss };
}
