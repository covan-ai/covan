import type { ChatSession } from "./agents-store";

/**
 * What a conversation is called on screen.
 *
 * One answer, because there were five: the chat header said "New thread", the
 * home page "Untitled chat", the search palette "Untitled", and a tester read
 * the same conversation under two names on one screen. The title is the
 * conversation's own once it has one — written by the first reply, or typed
 * in the sidebar — and until then it is named for what it is.
 *
 * Trimmed, because a title of spaces is a blank row, which the sidebar used to
 * draw. `kind` is optional for the one caller that does not have it: a browser
 * place carries its conversation's title and nothing else, so an untitled
 * brainstorm there reads as a thread until the API says which it is.
 */
export function sessionLabel(
  session: Pick<ChatSession, "title"> & { kind?: ChatSession["kind"] | null },
): string {
  const title = session.title?.trim();
  if (title) return title;
  return session.kind === "brainstorm" ? "New brainstorm" : "New thread";
}
