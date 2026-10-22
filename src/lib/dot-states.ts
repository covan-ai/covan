/** The five states of a dot (DESIGN.md §12), and the word that goes beside each. */
export type DotState = "running" | "waiting" | "done" | "idle" | "failed";

export const DOT_WORDS: Record<DotState, string> = {
  running: "Running",
  waiting: "Needs you",
  done: "Done",
  idle: "Idle",
  failed: "Failed",
};
