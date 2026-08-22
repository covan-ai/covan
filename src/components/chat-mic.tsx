import { useEffect } from "react";
import { Loader2, Mic } from "lucide-react";
import type { Dictation } from "@/lib/use-dictation";

/** Seconds as a clock, so two minutes reads as a length rather than a number. */
function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The dictate control in the chat composer, beside the attach control.
 *
 * Press to start, press again to stop — not press-and-hold. Holding a button
 * down is a mechanism nobody can drive from a keyboard, which is failure mode 5
 * in DESIGN.md; and a two-minute recording is not something to hold a mouse
 * button through anyway. Escape throws the recording away.
 *
 * Unlike `ChatAttach` this is shown to a viewer too. Attaching a document writes
 * to what the workspace shares and `can_write_in_workspace` refuses it; dictating
 * only fills in the caller's own message, which a viewer is free to send.
 */
export function ChatMic({ dictation }: { dictation: Dictation }) {
  const { supported, state, seconds, start, stop, cancel } = dictation;

  useEffect(() => {
    if (state !== "recording") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, cancel]);

  if (!supported) return null;

  // While recording the control stops being an icon and becomes the recording:
  // an amber square and the count against the two-minute ceiling. One square,
  // 8px, well inside the amber budget the send button already spends from.
  if (state === "recording") {
    return (
      <button
        type="button"
        onClick={stop}
        aria-label="Stop recording"
        title="Escape discards the recording"
        className="flex h-7 items-center gap-1.5 rounded-sm bg-muted px-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
      >
        <span className="h-2 w-2 shrink-0 bg-accent-orange" />
        <span className="tabular-nums">{clock(seconds)}</span>
      </button>
    );
  }

  const transcribing = state === "transcribing";

  return (
    <button
      type="button"
      onClick={() => void start()}
      disabled={transcribing}
      aria-label={transcribing ? "Transcribing your recording" : "Dictate a message"}
      className="grid h-7 w-7 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:hover:bg-transparent"
    >
      {transcribing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
    </button>
  );
}
