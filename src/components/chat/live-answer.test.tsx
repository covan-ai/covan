import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
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

  it("keeps the model's reasoning folded shut", () => {
    render(<LiveAnswer {...base} thinkingText="The question is about accrual." />);
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toHaveAttribute("open");
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
