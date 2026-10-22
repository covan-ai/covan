import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";

/**
 * A question the agent stopped to ask (A2): the amber ring, who is asking,
 * the question, and the answers it offered — the first as the primary
 * button. Pressing one sends it as the next message; typing is always the
 * other way to answer, so a question with no offered answers is just the
 * question.
 */
export function AskCard({
  agentName,
  question,
  replies,
  busy,
  onReply,
}: {
  agentName: string;
  question: string;
  replies: string[];
  busy: boolean;
  onReply: (reply: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label={`${agentName} is asking you`}
      className="mt-2 flex items-start gap-3 rounded-xl border border-border p-4"
    >
      <StatusDot state="waiting" className="mt-[7px]" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-sm font-medium">{agentName} is asking you</div>
        <div className="text-sm text-muted-foreground">{question}</div>
        {replies.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {replies.map((reply, i) => (
              <Button
                key={reply}
                variant={i === 0 ? "default" : "secondary"}
                disabled={busy}
                onClick={() => onReply(reply)}
              >
                {reply}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
