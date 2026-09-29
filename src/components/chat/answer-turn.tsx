import { memo } from "react";
import { Copy, RefreshCw, ThumbsDown, ThumbsUp, Volume2, VolumeX } from "lucide-react";
import type { Message } from "@/lib/agents-store";
import type { FeedbackKind } from "@/lib/api-client";
import { Markdown } from "@/components/markdown";
import { SourceChip } from "@/components/source-chip";
import { SettledSteps, toStepViews } from "@/components/agent-steps";
import { MsgAction } from "@/components/chat/turn-actions";
import { VersionPicker, RetryOn } from "@/components/chat/answer-controls";
import { estimateCostUsd, formatCost, formatTokens } from "@/lib/pricing";
import { cn } from "@/lib/utils";

/**
 * One answer in a transcript.
 *
 * MEMOISED, AND THE MEMO IS THE POINT. The route re-renders on every streamed
 * token. Before this, a hundred-message transcript re-parsed a hundred
 * Markdown documents per token — ninety-nine of them for answers whose text
 * had not changed since the conversation was loaded.
 *
 * `streamTail` is what makes that possible: the tokens still arriving for THIS
 * message, and `null` for every other row. Null is a stable primitive, so the
 * only turn React redraws per token is the one the tokens belong to. The
 * condition that used to decide this — `continuingId === m.id && replyingIn
 * === active?.id` — stays in the route, where the ids it compares live.
 *
 * EVERY PROP HAS TO BE STABLE OR THE MEMO IS A COMMENT, which is why:
 *
 * - callbacks take an id and never close over one, so the route can hold one
 *   identity for all of them (`useStableCallback`);
 * - the TTS object is never passed. `useTTS()` returns a fresh object every
 *   render and would break the memo unconditionally, so this takes four flat
 *   props instead;
 * - `truncated` and `stoppedShort` are two props rather than one, because a
 *   turn can hit its length cap AND its budget, and folding them together was
 *   how the second sentence used to disappear.
 *
 * An inline arrow function at the call site breaks all of it and NOTHING
 * FAILS: the tests still pass, the screen still works, and the transcript is
 * quietly slow again. There is a test here that counts redraws, and it is the
 * only thing standing between this and that.
 *
 * `FeedbackKind` is a type import on purpose. A value import from
 * `@/lib/api-client` would pull the mocked module into this component's graph
 * in `chat.test.tsx`.
 */
export const AnswerTurn = memo(function AnswerTurn({
  message,
  streamTail,
  time,
  busy,
  model,
  uploadedAt,
  canRegenerate,
  pickableModels,
  modelCosts,
  truncated,
  stoppedShort,
  canSpeak,
  speaking,
  onSpeak,
  onStopSpeaking,
  onCopy,
  onShowVersion,
  onRate,
  onContinue,
  onKeepGoing,
  onRegenerate,
}: {
  message: Message;
  /** Tokens still arriving for THIS message. Null for every settled row. */
  streamTail: string | null;
  /** Already formatted. A turn should not own a locale. */
  time: string;
  busy: boolean;
  /** Whose prices to quote for this reply's tokens. */
  model: string;
  uploadedAt: Map<string, number>;
  /** The last answer, to a question, in a session the reader owns. */
  canRegenerate: boolean;
  pickableModels: string[];
  modelCosts: Record<string, number> | undefined;
  /** The answer stopped at its length cap and can be carried on. */
  truncated: boolean;
  /** The turn stopped at a ceiling, and which one. */
  stoppedShort: "budget" | "tokens" | "runtime" | null;
  canSpeak: boolean;
  speaking: boolean;
  onSpeak: (text: string) => void;
  onStopSpeaking: () => void;
  onCopy: (content: string) => void;
  onShowVersion: (id: string) => void;
  onRate: (id: string, kind: FeedbackKind) => void;
  onContinue: (id: string) => void;
  onKeepGoing: () => void;
  onRegenerate: (model?: string) => void;
}) {
  const sources = message.sources ?? [];

  // No avatar, no name, no indent.
  //
  // There is one agent in this conversation and its name is in the rail, in
  // the header of the screen it was opened from, and under the composer.
  // Repeating it above every reply — with a tile and a clock beside it — meant
  // three lines of furniture for every answer, and pushed the answer itself
  // nine pixels off the margin the questions are measured from. The reply is
  // the only thing on this side of the transcript, so it is allowed to simply
  // be the text.
  return (
    <div className="group flex flex-col gap-2">
      <div className="min-w-0" data-turn="answer">
        <Markdown
          content={streamTail === null ? message.content : message.content + streamTail}
          className={cn("text-base text-foreground", streamTail !== null && "stream-live")}
        />

        {/* Which take on this answer is showing, when there is more than one.
            Beside the answer rather than in the hover actions, because it is a
            fact about what is on screen: somebody reading a regenerated reply
            needs to know the other one still exists without having to go
            looking. */}
        {message.versions && message.versions.length > 1 && (
          <VersionPicker
            versions={message.versions}
            current={message.id}
            busy={busy}
            onShow={onShowVersion}
          />
        )}

        {/* Above Sources, because it is the earlier half of the same sentence:
            these are the places the answer went looking, and those are the
            documents it came back with. Folded shut — somebody checking an
            answer opens it, and everybody else reads the reply. */}
        {message.steps && message.steps.length > 0 && (
          <SettledSteps steps={toStepViews(message.steps)} />
        )}

        {sources.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Sources</span>
            {sources.map((source, i) => (
              <SourceChip
                key={source.id ?? `${source.name}:${i}`}
                source={source}
                uploadedAt={source.id ? uploadedAt.get(source.id) : undefined}
              />
            ))}
          </div>
        )}

        {/* Not hidden behind hover like the actions below it. Those are
            conveniences; this one is the only thing saying the answer above it
            is unfinished, and an answer that stops mid-thought otherwise looks
            exactly like one that finished. */}
        {truncated && (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">This answer hit its length limit.</span>
            <button
              type="button"
              onClick={() => onContinue(message.id)}
              disabled={busy}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-secondary disabled:opacity-40"
            >
              Continue
            </button>
          </div>
        )}

        {/* The same argument as the row above, about the other way a reply
            stops early. This was a toast: four seconds, over an answer that
            looked finished, with nothing to press. The sentence differs by
            ceiling because they ask the person to narrow different things. */}
        {stoppedShort && (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {stoppedShort === "tokens"
                ? "This turn reached the most one answer is allowed to spend."
                : stoppedShort === "runtime"
                  ? // Neither of our budgets — the platform. Nothing to narrow,
                    // so the sentence points at the one thing that does work:
                    // the count resets per turn.
                    "This turn reached how much this deployment can do in one go."
                  : "This turn used every tool call it is allowed."}
            </span>
            <button
              type="button"
              onClick={onKeepGoing}
              disabled={busy}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-secondary disabled:opacity-40"
            >
              Keep going
            </button>
          </div>
        )}

        {message.promptTokens != null && message.completionTokens != null && (
          <div className="mt-2 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
            {formatTokens(message.promptTokens)} in · {formatTokens(message.completionTokens)} out
            {message.cachedTokens != null && message.cachedTokens > 0 && (
              <> · {formatTokens(message.cachedTokens)} cached</>
            )}
            {" · "}
            {formatCost(
              estimateCostUsd(
                model,
                message.promptTokens,
                message.completionTokens,
                message.cachedTokens ?? 0,
                message.cacheWriteTokens ?? 0,
              ),
            )}
          </div>
        )}

        <div className="mt-2 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {/* On the same line as the actions, and on the same hover. A
              timestamp on every answer is the kind of fact you want once and
              never again. */}
          <span className="mr-1.5 text-xs tabular-nums text-muted-foreground">{time}</span>
          <MsgAction label="Copy" onClick={() => onCopy(message.content)}>
            <Copy className="h-3.5 w-3.5" />
          </MsgAction>
          {canSpeak && (
            <MsgAction
              label={speaking ? "Stop reading" : "Read aloud"}
              onClick={() => (speaking ? onStopSpeaking() : onSpeak(message.content))}
            >
              {speaking ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
            </MsgAction>
          )}
          <MsgAction
            label="This answer was good — say why"
            onClick={() => onRate(message.id, "other")}
          >
            <ThumbsUp className="h-3.5 w-3.5" />
          </MsgAction>
          <MsgAction
            label="Something's wrong with this answer"
            onClick={() => onRate(message.id, "problem")}
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </MsgAction>
          {/* Ownership, not role — the same rule as Edit on a question.
              `messages_delete_owner` is keyed to whoever owns the SESSION, and
              so is `show_message_version`; offered to a colleague reading a
              shared thread this changed nothing, reported nothing, and then
              failed to answer a question that already had an answer under it.

              The last answer only. Regenerating one in the middle would leave
              every turn after it replying to something no longer there, and
              making those turns a branch is a conversation tree rather than a
              version list — a different feature, and a much larger one.

              The caller works all that out; this takes the conclusion. */}
          {canRegenerate && (
            <>
              <MsgAction label="Regenerate" onClick={() => onRegenerate()}>
                <RefreshCw className="h-3.5 w-3.5" />
              </MsgAction>
              <RetryOn models={pickableModels} costs={modelCosts} onPick={onRegenerate} />
            </>
          )}
        </div>
      </div>
    </div>
  );
});
