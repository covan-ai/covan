/**
 * Whether the conversation should keep following its own bottom edge.
 *
 * A chat that scrolls to the bottom on every token is right until the moment
 * someone scrolls up — which is the moment they most want it to hold still.
 * Reading back over what the agent said two answers ago while a long reply is
 * streaming was impossible: each token yanked the view back down, so the only
 * way to read the conversation was to wait for the answer to finish.
 *
 * So the view follows the stream only while the reader is already at the
 * bottom. The tolerance is what makes that usable — "at the bottom" has to
 * survive a few pixels of rounding, a rubber-banding trackpad, and the growth
 * of the last line as it wraps.
 */
export const STICK_TOLERANCE_PX = 96;

export type ScrollBox = { scrollTop: number; scrollHeight: number; clientHeight: number };

export function isPinnedToBottom(box: ScrollBox, tolerance = STICK_TOLERANCE_PX): boolean {
  const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
  return distanceFromBottom <= tolerance;
}
