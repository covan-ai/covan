import type { Message } from "@/lib/agents-store";

/** The id a message is given while it exists only on this screen. */
export const OPTIMISTIC_PREFIX = "temp-";

export const optimisticId = () => `${OPTIMISTIC_PREFIX}${crypto.randomUUID()}`;

const isOptimistic = (m: Message) => m.id.startsWith(OPTIMISTIC_PREFIX);

/**
 * Fold a message that arrived over Realtime into the list on screen.
 *
 * Two things have to happen here that appending does not do.
 *
 * The first is the round trip a sender sees of their own message. It is drawn
 * optimistically the moment they press send, under a temporary id, and then
 * comes back over the subscription under its real one — so in a shared session
 * everyone's own messages appeared twice for as long as the refetch took. The
 * optimistic copy is the same message and is replaced rather than kept beside
 * it.
 *
 * The second is order. A peer's message can land while a local one is still
 * only optimistic, and the optimistic row is stamped with this browser's clock,
 * which is not the database's. Inserting by timestamp rather than appending
 * keeps the transcript in the order it will still be in after the refetch,
 * instead of letting it re-shuffle under the reader a moment later.
 */
export function mergeRealtimeMessage(list: Message[], incoming: Message): Message[] {
  if (list.some((m) => m.id === incoming.id)) return list;

  const withoutOptimistic = list.filter(
    (m) => !(isOptimistic(m) && m.role === incoming.role && m.content === incoming.content),
  );

  const at = withoutOptimistic.findIndex((m) => m.createdAt > incoming.createdAt);
  if (at === -1) return [...withoutOptimistic, incoming];
  return [...withoutOptimistic.slice(0, at), incoming, ...withoutOptimistic.slice(at)];
}

/**
 * Fold the server's own copy of a message into the list on screen.
 *
 * Different from `mergeRealtimeMessage` in one way that matters: an id already
 * on the list is *replaced* rather than left alone. Realtime only ever
 * announces rows that are new, so skipping a known id is right there. The end
 * of a stream is not the same thing — a continuation rewrites the reply it
 * finishes, so the row that comes back carries an id already on screen and
 * content that is longer than what is under it. Skipping it would leave the
 * first half showing and the second half nowhere.
 */
export function settleMessage(list: Message[], incoming: Message): Message[] {
  const at = list.findIndex((m) => m.id === incoming.id);
  if (at === -1) return mergeRealtimeMessage(list, incoming);
  return [...list.slice(0, at), incoming, ...list.slice(at + 1)];
}
