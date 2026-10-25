import { memo } from "react";
import { Copy, RefreshCw, ThumbsDown, ThumbsUp, Volume2, VolumeX } from "lucide-react";
import type { Message } from "@/lib/agents-store";
import { Button } from "@/components/ui/button";
import type { FeedbackKind } from "@/lib/api-client";
import { Markdown } from "@/components/markdown";
import { SourceChip } from "@/components/source-chip";
import { SettledSteps, toStepViews } from "@/components/agent-steps";
import { MsgAction } from "@/components/chat/turn-actions";
import { VersionPicker, RetryOn } from "@/components/chat/answer-controls";
import { estimateCostUsd, formatCost, formatTokens } from "@/lib/pricing";
import type { ReplyPrices } from "@/lib/agent-meta";
import type { ToolConnection } from "@/lib/connections-api";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";

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
  prices,
  connections,
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
  className,
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
  /** What each model costs per reply, in the unit the server answers in. */
  prices: ReplyPrices | undefined;
  /** The workspace's connected services, for the marks in the step trail. */
  connections?: ToolConnection[];
  /** The answer stopped at its length cap and can be carried on. */
  truncated: boolean;
  /** The turn stopped at a ceiling, and which one. */
  stoppedShort: "budget" | "tokens" | "runtime" | "credits" | null;
  canSpeak: boolean;
  speaking: boolean;
  onSpeak: (id: string, text: string) => void;
  onStopSpeaking: () => void;
  onCopy: (content: string, messageId: string) => void;
  onShowVersion: (id: string) => void;
  onRate: (id: string, kind: FeedbackKind) => void;
  onContinue: (id: string) => void;
  onKeepGoing: () => void;
  onRegenerate: (model?: string) => void;
  /** How much air goes above this turn. See `gapBefore`. */
  className?: string;
}) {
  const { t } = useTranslation();
  const sources = message.sources ?? [];

  // No byline (A2): the agent is named in the bar over the page, and the
  // reply starts at the margin the questions are measured from. What it did
  // comes first, folded into one line, then what it wrote.
  return (
    <div className={cn("group flex flex-col gap-2", className)}>
      <div className="min-w-0" data-turn="answer">
        {message.steps && message.steps.length > 0 && (
          <SettledSteps
            steps={toStepViews(message.steps)}
            connections={connections}
            sources={sources.length}
            className="mb-3"
          />
        )}
        <Markdown
          content={streamTail === null ? message.content : message.content + streamTail}
          className={cn(
            "text-base leading-[1.65] text-foreground",
            streamTail !== null && "stream-live",
          )}
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

        {sources.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground">
            <span>{t("Sources")}</span>
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
            <span className="text-xs text-muted-foreground">
              {t("This answer hit its length limit.")}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onContinue(message.id)}
              disabled={busy}
            >
              {t("Continue")}
            </Button>
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
                ? t("This turn reached the most one answer is allowed to spend.")
                : stoppedShort === "runtime"
                  ? // Neither of our budgets — the platform. Nothing to narrow,
                    // so the sentence points at the one thing that does work:
                    // the count resets per turn.
                    t("This turn reached how much this deployment can do in one go.")
                  : stoppedShort === "credits"
                    ? // The workspace's, checked before every step. Keep going
                      // would be refused until somebody adds credit, so it is
                      // not offered.
                      t("This workspace ran out of credits partway through this answer.")
                    : t("This turn used every tool call it is allowed.")}
            </span>
            {stoppedShort !== "credits" && (
              <Button variant="secondary" size="sm" onClick={onKeepGoing} disabled={busy}>
                {t("Keep going")}
              </Button>
            )}
          </div>
        )}

        {/* The third way a reply ends early, and the only one somebody chose.
            Said for the same reason as the two rows above: a reply cut off
            mid-sentence otherwise reads, after a reload, as one that
            finished. No button — the person who stopped it can ask again. */}
        {message.outcome === "stopped" && !truncated && !stoppedShort && (
          <p className="mt-3 text-meta text-muted-foreground">{t("You stopped this answer.")}</p>
        )}

        {message.promptTokens != null && message.completionTokens != null && (
          <div
            data-part="cost"
            className="mt-2 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          >
            {message.cachedTokens != null && message.cachedTokens > 0
              ? t("{{prompt}} in · {{completion}} out · {{cached}} cached", {
                  prompt: formatTokens(message.promptTokens),
                  completion: formatTokens(message.completionTokens),
                  cached: formatTokens(message.cachedTokens),
                })
              : t("{{prompt}} in · {{completion}} out", {
                  prompt: formatTokens(message.promptTokens),
                  completion: formatTokens(message.completionTokens),
                })}
            {/* Priced here, in the browser, from list prices — which is a
                dollar figure and nothing else. Where the deployment charges
                credits that figure is the wrong unit, and the server has not
                quoted this message, so the tokens stand alone. */}
            {prices?.unit !== "credits" && (
              <>
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
              </>
            )}
          </div>
        )}

        {/* On screen, not behind a hover.
            
            Failure mode #5: a control revealed only by a pointer does not
            exist on a phone, and Copy and the two feedback buttons are not
            conveniences — they are how anybody tells us an answer was wrong.
            The cost badge above stays hover-only because it genuinely is
            incidental, which is why the wrapper keeps its `group`. */}
        <div data-part="actions" className="mt-2 flex items-center gap-0.5">
          <span className="mr-1.5 text-xs text-micro-foreground tabular-nums">{time}</span>
          <MsgAction label={t("Copy")} onClick={() => onCopy(message.content, message.id)}>
            <Copy className="h-3.5 w-3.5" />
          </MsgAction>
          {canSpeak && (
            <MsgAction
              label={speaking ? t("Stop reading") : t("Read aloud")}
              onClick={() => (speaking ? onStopSpeaking() : onSpeak(message.id, message.content))}
            >
              {speaking ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
            </MsgAction>
          )}
          <MsgAction
            label={t("This answer was good — say why")}
            onClick={() => onRate(message.id, "other")}
          >
            <ThumbsUp className="h-3.5 w-3.5" />
          </MsgAction>
          <MsgAction
            label={t("Something's wrong with this answer")}
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
              <MsgAction label={t("Regenerate")} onClick={() => onRegenerate()}>
                <RefreshCw className="h-3.5 w-3.5" />
              </MsgAction>
              <RetryOn models={pickableModels} prices={prices} onPick={onRegenerate} />
            </>
          )}
        </div>
      </div>
    </div>
  );
});
