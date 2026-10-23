import { englishT, type Translate } from "@/i18n";
import type { InboxItem } from "@/lib/api-client";
import type { DotState } from "@/lib/dot-states";

/** What the dot on a row says: waiting on you, running, failed, or done. */
export function inboxDot(item: InboxItem): DotState {
  if (item.needsYou) return item.needsYou.kind === "routine_failed" ? "failed" : "waiting";
  if (item.running) return "running";
  return "done";
}

/** The second line: what waits on you, what it is doing, or the last word. */
export function inboxLine(
  item: InboxItem,
  agentName: string,
  t: Translate = englishT,
): { who: string; text: string } {
  if (item.needsYou) return { who: agentName, text: item.needsYou.summary };
  if (item.running) {
    return {
      who: agentName,
      text: item.running.note ?? t("Working · step {{step}}", { step: item.running.stepsDone + 1 }),
    };
  }
  if (item.preview) {
    const who =
      item.preview.role === "assistant" ? agentName : (item.preview.senderName ?? t("You"));
    return { who, text: item.preview.text };
  }
  return { who: agentName, text: t("No messages yet") };
}
