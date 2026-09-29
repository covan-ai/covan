import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Message } from "@/lib/agents-store";
import { AnswerTurn } from "./answer-turn";

/**
 * One answer in a transcript, and the memo that keeps the other ninety-nine
 * from re-rendering on every token.
 *
 * `Markdown` is wrapped rather than replaced: the real one still renders, so
 * the assertions about `.stream-live` are about real DOM, and the wrapper adds
 * the one thing the real one cannot give — a count of how often this turn drew
 * itself.
 */
let draws = 0;
vi.mock("@/components/markdown", async (original) => {
  const actual = await original<typeof import("@/components/markdown")>();
  return {
    Markdown: (props: { content: string; className?: string }) => {
      draws++;
      return <actual.Markdown {...props} />;
    },
  };
});

const message = (over: Partial<Message> = {}): Message => ({
  id: "a1",
  role: "assistant",
  content: "Integration tickets take 41% of resolution time.",
  createdAt: 0,
  ...over,
});

const base = {
  message: message(),
  streamTail: null,
  agentName: "Support Insights",
  agentEmoji: "📊",
  time: "13:30",
  busy: false,
  model: "gpt-4.1",
  uploadedAt: new Map<string, number>(),
  canRegenerate: false,
  pickableModels: [] as string[],
  modelCosts: undefined,
  truncated: false,
  stoppedShort: null,
  canSpeak: false,
  speaking: false,
  onSpeak: (_id: string, _text: string) => {},
  onStopSpeaking: () => {},
  onCopy: () => {},
  onShowVersion: () => {},
  onRate: () => {},
  onContinue: () => {},
  onKeepGoing: () => {},
  onRegenerate: () => {},
};

beforeEach(() => {
  draws = 0;
});

describe("AnswerTurn", () => {
  it("is the answer, with the marker the transcript's tests count", () => {
    const { container } = render(<AnswerTurn {...base} />);
    expect(screen.getByText(/41% of resolution time/)).toBeInTheDocument();
    expect(container.querySelectorAll('[data-turn="answer"]')).toHaveLength(1);
  });

  it("shows the stored answer alone when nothing is arriving", () => {
    const { container } = render(<AnswerTurn {...base} streamTail={null} />);
    expect(container.querySelector(".stream-live")).not.toBeInTheDocument();
  });

  it("draws arriving words on the END of the answer, not under it", () => {
    // The server writes a continuation into the same row. Anything else shows
    // two answers for the length of the stream and then silently becomes one.
    render(<AnswerTurn {...base} streamTail=" The cause is a webhook secret." />);
    expect(
      screen.getByText(/41% of resolution time\. The cause is a webhook secret\./),
    ).toBeInTheDocument();
  });

  it("puts stream-live on the Markdown wrapper itself, not on a parent", () => {
    // `markdown.tsx` looks UPWARD for it — a code block asks
    // `closest(".stream-live")` to decide whether to skip highlighting while
    // tokens are still arriving. On a parent it would still be found; on a
    // SIBLING it would not, and the answer's own element is the one place that
    // cannot be got wrong later.
    const { container } = render(<AnswerTurn {...base} streamTail=" more" />);
    const live = container.querySelector(".stream-live");
    expect(live).toBeInTheDocument();
    expect(live).toHaveTextContent("41% of resolution time. more");
  });

  /**
   * The reason this component is memoised at all.
   *
   * The route re-renders on every streamed token. Before the memo, a
   * hundred-message transcript re-parsed a hundred Markdown documents per
   * token — for ninety-nine answers whose text had not changed.
   */
  it("does not redraw when the transcript re-renders around it", async () => {
    function Parent() {
      const [tick, setTick] = useState(0);
      return (
        <div>
          <button onClick={() => setTick((t) => t + 1)}>tick {tick}</button>
          <AnswerTurn {...base} />
        </div>
      );
    }
    render(<Parent />);
    expect(draws).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: /tick/ }));
    await userEvent.click(screen.getByRole("button", { name: /tick/ }));

    expect(draws).toBe(1);
  });

  it("does redraw for the one answer the tokens belong to", async () => {
    function Parent() {
      const [tail, setTail] = useState("");
      return (
        <div>
          <button onClick={() => setTail((t) => `${t}x`)}>token</button>
          <AnswerTurn {...base} streamTail={tail} />
        </div>
      );
    }
    render(<Parent />);
    expect(draws).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "token" }));
    expect(draws).toBe(2);
  });

  it("hands work back by id rather than doing it", async () => {
    const onCopy = vi.fn();
    const onRate = vi.fn();
    render(
      <AnswerTurn {...base} message={message({ id: "a9" })} onCopy={onCopy} onRate={onRate} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(onCopy).toHaveBeenCalledWith("Integration tickets take 41% of resolution time.");

    await userEvent.click(screen.getByRole("button", { name: /something's wrong/i }));
    expect(onRate).toHaveBeenCalledWith("a9", "problem");
  });

  it("reads this answer aloud, and only says Stop while it is reading", async () => {
    const onSpeak = vi.fn();
    const { rerender } = render(
      <AnswerTurn {...base} message={message({ id: "a4" })} canSpeak onSpeak={onSpeak} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Read aloud" }));
    // The id goes with it. `speaking` used to be one flag for the whole
    // screen, so reading ONE answer aloud put every answer's button into
    // "Stop reading" — invisible while the actions were hover-only, and a
    // screenful of wrong buttons once they stopped being.
    expect(onSpeak).toHaveBeenCalledWith("a4", "Integration tickets take 41% of resolution time.");

    rerender(
      <AnswerTurn {...base} message={message({ id: "a4" })} canSpeak speaking onSpeak={onSpeak} />,
    );
    expect(screen.getByRole("button", { name: "Stop reading" })).toBeInTheDocument();
  });

  /**
   * The header the answer grew, and the actions that stopped hiding.
   *
   * Both reverse a decision this component's comment used to argue for, and
   * both are only affordable because the transcript around them lost furniture
   * at the same time — the per-message clock, the open step trail, the
   * separate line of dots.
   */
  it("says who is answering, once, above the answer", () => {
    render(<AnswerTurn {...base} />);
    expect(screen.getByText("Support Insights")).toBeInTheDocument();
  });

  it("puts the time in that header rather than in the action strip", () => {
    const { container } = render(<AnswerTurn {...base} />);
    const header = container.querySelector("[data-part='byline']");
    expect(header).toHaveTextContent("Support Insights");
    expect(header).toHaveTextContent("13:30");
  });

  it("leaves the actions on screen instead of waiting for a mouse", () => {
    // Failure mode #5. Copy, read-aloud and the two feedback buttons were
    // `opacity-0` until hover, which on a phone means they do not exist.
    const { container } = render(<AnswerTurn {...base} />);
    const actions = container.querySelector("[data-part='actions']");
    expect(actions?.className).not.toMatch(/opacity-0/);
  });

  it("keeps the hover group, because the cost badge still rides on it", () => {
    // Taking `group` off the wrapper when the actions stopped needing it would
    // have made the token count permanently invisible — it is the one thing
    // here that is genuinely incidental and still hover-only.
    const { container } = render(
      <AnswerTurn {...base} message={message({ promptTokens: 100, completionTokens: 50 })} />,
    );
    expect(container.firstElementChild?.className).toMatch(/\bgroup\b/);
    expect(container.querySelector("[data-part='cost']")?.className).toMatch(/group-hover/);
  });

  it("offers nothing to read aloud where the browser cannot", () => {
    render(<AnswerTurn {...base} canSpeak={false} />);
    expect(screen.queryByRole("button", { name: /read aloud/i })).not.toBeInTheDocument();
  });

  /**
   * Two ways a reply stops early, and they are not exclusive. A turn can hit
   * its length cap AND its budget, so these are two props rather than one
   * enum — which is the shape that used to hide the second sentence.
   */
  it("says an answer hit its length limit, with something to press", async () => {
    const onContinue = vi.fn();
    render(
      <AnswerTurn {...base} message={message({ id: "a3" })} truncated onContinue={onContinue} />,
    );

    expect(screen.getByText(/hit its length limit/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledWith("a3");
  });

  it("says a turn spent its budget, in the words of the ceiling it hit", () => {
    const { rerender } = render(<AnswerTurn {...base} stoppedShort="tokens" />);
    expect(screen.getByText(/most one answer is allowed to spend/)).toBeInTheDocument();

    rerender(<AnswerTurn {...base} stoppedShort="runtime" />);
    expect(screen.getByText(/this deployment can do in one go/)).toBeInTheDocument();

    rerender(<AnswerTurn {...base} stoppedShort="budget" />);
    expect(screen.getByText(/every tool call it is allowed/)).toBeInTheDocument();
  });

  it("can say both at once", () => {
    render(<AnswerTurn {...base} truncated stoppedShort="tokens" />);
    expect(screen.getByText(/hit its length limit/)).toBeInTheDocument();
    expect(screen.getByText(/most one answer is allowed to spend/)).toBeInTheDocument();
  });

  it("names the documents the answer came back with", () => {
    render(
      <AnswerTurn {...base} message={message({ sources: [{ id: "d1", name: "q3-review" }] })} />,
    );
    expect(screen.getByText("Sources")).toBeInTheDocument();
    expect(screen.getByText("q3-review")).toBeInTheDocument();
  });

  it("offers the other takes only when there is more than one", () => {
    const { rerender } = render(<AnswerTurn {...base} message={message({ versions: ["a1"] })} />);
    expect(screen.queryByLabelText(/version 1 of/i)).not.toBeInTheDocument();

    rerender(<AnswerTurn {...base} message={message({ versions: ["a0", "a1"] })} />);
    expect(screen.getByLabelText("Version 2 of 2")).toBeInTheDocument();
  });

  it("offers a regenerate only where the caller says it belongs", () => {
    const { rerender } = render(<AnswerTurn {...base} canRegenerate={false} />);
    expect(screen.queryByRole("button", { name: "Regenerate" })).not.toBeInTheDocument();

    rerender(<AnswerTurn {...base} canRegenerate />);
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeInTheDocument();
  });
});
