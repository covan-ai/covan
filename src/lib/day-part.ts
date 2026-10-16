/**
 * The part of the day, for a greeting that reads as if somebody looked at a
 * clock: "What can I do for you this morning?"
 */
export function dayPart(now: Date = new Date()): string {
  const h = now.getHours();
  if (h < 5) return "tonight";
  if (h < 12) return "this morning";
  if (h < 18) return "this afternoon";
  return "this evening";
}
