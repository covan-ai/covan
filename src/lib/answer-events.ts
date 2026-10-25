/**
 * Copying, reading aloud and saving an answer, announced as an event on
 * `window` for a listener an operator's build may add. Nothing here acts on it.
 *
 * Announcing never changes the action and never throws.
 */

export type AnswerAction = {
  action: "copied" | "spoken" | "saved";
  messageId: string;
  /** Only for `saved`. */
  format?: "md" | "docx" | "pdf";
};

export const ANSWER_EVENT = "covan:answer";

export function announceAnswerAction(a: AnswerAction): void {
  try {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(ANSWER_EVENT, { detail: a }));
  } catch {
    // Nothing to tell: the action itself has already happened.
  }
}
