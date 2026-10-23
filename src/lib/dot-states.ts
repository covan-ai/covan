import { englishT, type Translate } from "@/i18n";

/** The five states of a dot (DESIGN.md §12), and the word that goes beside each. */
export type DotState = "running" | "waiting" | "done" | "idle" | "failed";

/** The English words, for a caller with no `t` in reach. Translated: `dotWord`. */
export const DOT_WORDS: Record<DotState, string> = {
  running: "Running",
  waiting: "Needs you",
  done: "Done",
  idle: "Idle",
  failed: "Failed",
};

/**
 * The word beside a dot, in the reader's language. "Done" here is a state,
 * not the button that closes a dialog, and the two are different words in
 * Turkish — hence the context.
 */
export function dotWord(state: DotState, t: Translate = englishT): string {
  switch (state) {
    case "running":
      return t("Running");
    case "waiting":
      return t("Needs you");
    case "done":
      return t("Done", { context: "status", defaultValue: "Done" });
    case "idle":
      return t("Idle");
    case "failed":
      return t("Failed");
  }
}
