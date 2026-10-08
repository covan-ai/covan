import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LiveAnswer } from "./live-answer";

/**
 * The reply while it is still arriving.
 *
 * The claims worth holding are about what is on screen at the same time as
 * what else, because a turn that calls tools goes quiet repeatedly and each
 * quiet gap used to take the already-written words away.
 */

const base = {
  streamText: "",
  thinkingText: "",
  thinking: false,
  steps: [],
  streaming: true,
};

describe("LiveAnswer", () => {
  it("is one answer, which is what the transcript's tests count", () => {
    const { container } = render(<LiveAnswer {...base} streamText="Working on it" />);
    expect(container.querySelectorAll('[data-turn="answer"]')).toHaveLength(1);
  });

  it("says nothing to a screen reader while the words are still arriving", () => {
    // Announcing a growing string on every token is not access, it is a
    // torrent. The status line at the foot says *that* a reply is coming, and
    // the log above reads it out once it lands as a finished thing.
    const { container } = render(<LiveAnswer {...base} streamText="half a sen" />);
    expect(container.querySelector('[aria-live="off"]')).toBeInTheDocument();
  });

  it("shows the words and the dots together, not one or the other", () => {
    // This was a ternary, which was right while a turn wrote once. A tool turn
    // goes quiet after every pass, and bringing the dots back for those gaps
    // used to take the written text off the screen.
    render(<LiveAnswer {...base} streamText="Checking the tickets" thinking />);
    expect(screen.getByText(/Checking the tickets/)).toBeInTheDocument();
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });

  it("draws the caret while tokens arrive and drops it when they stop", () => {
    // `streaming` and `thinking` are different questions. Once the stream
    // stops, the text on screen is waiting to be replaced by the server's copy
    // rather than still being written — so the caret goes even though the turn
    // has not settled.
    const { container, rerender } = render(<LiveAnswer {...base} streamText="done" streaming />);
    expect(container.querySelector(".stream-live")).toBeInTheDocument();

    rerender(<LiveAnswer {...base} streamText="done" streaming={false} />);
    expect(container.querySelector(".stream-live")).not.toBeInTheDocument();
  });

  it("puts what the agent went and did above what it came back with", () => {
    const { container } = render(
      <LiveAnswer
        {...base}
        steps={[{ index: 0, tool: "search_documents", status: "running", label: "leave policy" }]}
        streamText="According to the handbook"
      />,
    );
    const text = container.textContent ?? "";
    expect(text.indexOf("leave policy")).toBeLessThan(text.indexOf("According to the handbook"));
  });

  /**
   * This assertion was the opposite one until the reasoning block arrived: the
   * fold was closed while the model worked and a reader got the word
   * "Thinking" and nothing else — no duration, no sense of whether it was
   * still happening, no reason to open it. §2 of the design overturns that
   * deliberately. What is still true is that it does not stay open: it folds
   * itself once the reasoning stops, so nobody scrolls past it to read the
   * reply.
   */
  it("is open while the model is still reasoning", () => {
    render(<LiveAnswer {...base} thinkingText="The question is about accrual." />);
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText(/about accrual/)).toBeVisible();
  });

  it("folds itself shut once the reasoning has stopped, and says how long it took", () => {
    render(
      <LiveAnswer
        {...base}
        thinkingText="The question is about accrual."
        thinkingMs={2400}
        streamText="You accrue 1.67 days a month."
      />,
    );
    expect(screen.getByText("Thought for 2.4s")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Thought for 2.4s/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("does not overrule a reader who opened it", async () => {
    const { rerender } = render(
      <LiveAnswer {...base} thinkingText="Working through accrual." thinkingMs={900} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Thought for 0.9s/ }));

    rerender(<LiveAnswer {...base} thinkingText="Working through accrual." thinkingMs={900} />);
    expect(screen.getByRole("button", { name: /Thought for 0.9s/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("draws no reasoning block when the model published none", () => {
    render(<LiveAnswer {...base} thinkingText="" streamText="An answer" />);
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
  });

  it("hides the dots from a screen reader rather than labelling them", () => {
    // They carried an `aria-label` on a bare `<div>` once, which is a string
    // most screen readers have nowhere to put. The words live in the status
    // line at the foot of the conversation, where they are announced.
    const { container } = render(<LiveAnswer {...base} thinking />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  });
});
