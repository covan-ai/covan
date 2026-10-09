import { Markdown } from "@/components/markdown";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/prompt-kit/reasoning";
import { StepTrail, type AgentStepView } from "@/components/agent-steps";
import { cn } from "@/lib/utils";

/**
 * The reply that is still arriving.
 *
 * NOT MEMOISED, and that is deliberate rather than an omission. A settled
 * answer redraws when its text changes, which is never; this one redraws on
 * every token, which is the whole of what it is for. A memo here would be a
 * comparison run per token that always says "changed".
 *
 * WHETHER it is drawn stays in the route: `continuingId === null &&
 * (replyingIn === active?.id || settlingIn === active?.id)`. A continuation is
 * written onto the end of the answer above instead, and `chat.test.tsx` asserts
 * that exactly one `data-turn="answer"` exists while one is running — so that
 * gate is load-bearing and lives where the session ids it compares live.
 */
export function LiveAnswer({
  streamText,
  thinkingText,
  thinkingMs,
  thinking,
  steps,
  streaming,
  className,
}: {
  /** The answer so far. Empty while the model is between passes. */
  streamText: string;
  /** The model's own reasoning, when it published any. */
  thinkingText: string;
  /**
   * How long the model reasoned for, or null while it still is.
   *
   * The clock is kept in the route, because that is where the events are: the
   * window runs from the first `thinking` event to the first `delta` after it.
   * Null is therefore two things at once and both are the same thing here —
   * reasoning has not finished — which is what the fold reads to decide
   * whether to be open.
   *
   * The settled label is a DURATION AND NOTHING ELSE. `SettledSteps` sits
   * directly beneath this and already prints "3 steps · 2.4s"; a reasoning
   * token count beside that is a second family of numbers saying something a
   * reader did not ask, and `MessageDTO.reasoningTokens` is null on every
   * Anthropic reply in any case.
   */
  thinkingMs?: number | null;
  /** Something is happening right now, so the dots belong on screen. */
  thinking: boolean;
  steps: AgentStepView[];
  /**
   * Tokens are still arriving, as opposed to the answer having stopped and
   * being about to be replaced by the server's copy. This is what draws the
   * caret, and dropping it at the right moment is why it is not the same
   * question as `thinking`.
   */
  streaming: boolean;
  className?: string;
}) {
  // Still arriving, as against having arrived. `thinkingMs` is set by the
  // route the moment the first answer token lands, which is the moment the
  // model stopped reasoning for this pass.
  const reasoningLive = streaming && thinkingMs === null;

  return (
    // Outside the log, and silent. The words arrive here one token at a time;
    // a screen reader is told *that* a reply is coming by the status line
    // below, and reads the reply itself once it lands in the log above as a
    // finished thing.
    <div className={cn("flex flex-col gap-2", className)} aria-live="off">
      <div className="min-w-0" data-turn="answer">
        {/* What the model is working through, while it works through it.
            OPEN while it is still working through it, and folded the moment it
            stops. This was a closed `Disclosure` labelled "Thinking", which
            gave a reader the word and nothing else: no duration, no sign of
            whether it was still happening, no reason to open it. Open-while-
            streaming is the whole reason this block came from prompt-kit
            rather than being written here — and it leaves a reader who folded
            or unfolded it by hand alone afterwards. */}
        {thinkingText && (
          <Reasoning className="mb-3" isStreaming={reasoningLive}>
            <ReasoningTrigger className="text-xs text-muted-foreground hover:text-foreground">
              {thinkingMs === null || thinkingMs === undefined
                ? "Thinking"
                : `Thought for ${(thinkingMs / 1000).toFixed(1)}s`}
            </ReasoningTrigger>
            <ReasoningContent className="mt-1.5">
              <Markdown content={thinkingText} className="text-xs" />
            </ReasoningContent>
          </Reasoning>
        )}

        {/* Between the reasoning and the answer, which is where they happen. A
            step line is the one thing on this screen that says the agent left
            the room — it went and read something — and it belongs above the
            words that came back from it. */}
        {steps.length > 0 && <StepTrail steps={steps} className="mb-3" />}

        {/*
          The words so far, and the dots, as siblings rather than as two
          branches of a ternary.

          They used to be either/or, which was right while a turn wrote once:
          there was nothing to show until the model started, and once it started
          it never went quiet again. A tool turn goes quiet repeatedly — every
          pass after the first begins with the model reading a tool result,
          which can take many seconds and produces nothing. With the ternary,
          bringing the dots back for those gaps would have taken the
          already-written text off the screen.

          So: text if there is any, dots if something is happening, and
          frequently both.
        */}
        {streamText && (
          // The same renderer the settled answer uses, so the reply arrives in
          // the shape it will keep. It used to be plain `whitespace-pre-wrap`,
          // which meant watching raw `**`, bare `|` rows and unopened fences
          // for the length of the answer and then having the whole thing reflow
          // into something else the moment it finished. That reflow was the
          // single most visible difference between this and the chat products
          // people arrive from.
          //
          // Measured before it was written: a full parse and mount of a
          // 700-character answer costs ~1.1ms per delta under jsdom, which
          // re-mounts the tree every time. A browser re-renders an existing one.
          // There is nothing here to batch.
          //
          // `stream-live` is what draws the caret — see `styles.css`. A sibling
          // span cannot: the answer is blocks now, and a span after them sits on
          // its own line under the last paragraph rather than at the end of it.
          // Dropped once the stream stops, because at that point the text is
          // waiting to be replaced by the server's copy rather than still
          // arriving.
          <Markdown
            content={streamText}
            className={cn("text-base text-foreground", streaming && "stream-live")}
          />
        )}

        {thinking && (
          // `aria-hidden`, where this used to carry an `aria-label` on a bare
          // `<div>` — a label on an element with no role is a string most
          // screen readers have nowhere to put. The words are in the status
          // line at the foot of the conversation instead, where they are
          // announced rather than merely present.
          <div
            className={cn(
              "flex items-center gap-1.5 text-xs text-muted-foreground",
              streamText && "mt-2",
            )}
            aria-hidden="true"
          >
            <span className="typing-dot h-1.5 w-1.5 rounded-full bg-muted-foreground" />
            <span
              className="typing-dot h-1.5 w-1.5 rounded-full bg-muted-foreground"
              style={{ animationDelay: "0.15s" }}
            />
            <span
              className="typing-dot h-1.5 w-1.5 rounded-full bg-muted-foreground"
              style={{ animationDelay: "0.3s" }}
            />
            <span className="ml-1">Thinking…</span>
          </div>
        )}
      </div>
    </div>
  );
}
