import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Message } from "@/lib/agents-store";
import { QuestionTurn } from "./question-turn";

/**
 * One question in a transcript.
 *
 * It closes over nothing: WHICH message is open for editing, whether uploads
 * are still arriving, and who the reader is all stay in the route. What
 * arrives here is a message, a name to put above it when there is one, and
 * what the reader is allowed to do about it.
 */

const message = (over: Partial<Message> = {}): Message => ({
  id: "m1",
  role: "user",
  content: "How many vacation days do I have?",
  createdAt: 0,
  ...over,
});

/** The bubble, and the line of small print that goes with it. */
const bubble = (container: HTMLElement) => container.querySelector("[data-part='bubble']");
const meta = (container: HTMLElement) => container.querySelector("[data-part='meta']");

const base = {
  message: message(),
  sender: null,
  time: "13:30",
  canEdit: true,
  busy: false,
  onEdit: () => {},
};

describe("QuestionTurn", () => {
  it("shows what was asked, and when", () => {
    render(<QuestionTurn {...base} />);
    expect(screen.getByText("How many vacation days do I have?")).toBeInTheDocument();
    expect(screen.getByText("13:30")).toBeInTheDocument();
  });

  it("names the person only in a conversation that has more than one", () => {
    // `sender` is resolved by the caller rather than read off the message: a
    // private session has a sender on every row and nobody to distinguish it
    // from, and printing your own name above your own question is furniture.
    const { rerender } = render(<QuestionTurn {...base} sender={null} />);
    expect(screen.queryByText("Ana")).not.toBeInTheDocument();

    rerender(<QuestionTurn {...base} sender={{ name: "Ana", avatarUrl: null }} />);
    expect(screen.getByText("Ana")).toBeInTheDocument();
  });

  it("calls a teammate whose name we do not have something", () => {
    render(<QuestionTurn {...base} sender={{ name: null, avatarUrl: null }} />);
    expect(screen.getByText("Someone")).toBeInTheDocument();
  });

  it("hands the edit back with the id and the text, rather than acting itself", () => {
    const onEdit = vi.fn();
    render(<QuestionTurn {...base} message={message({ id: "m7" })} onEdit={onEdit} />);

    screen.getByRole("button", { name: /edit/i }).click();
    expect(onEdit).toHaveBeenCalledWith("m7", "How many vacation days do I have?");
  });

  it("offers no edit over somebody else's question", () => {
    // Not a styling choice. `messages_update_owner` is keyed to whoever owns
    // the SESSION, so the button used to appear over a colleague's message and
    // answer 404 — and editing discards every reply after the edited turn,
    // which is not something to offer over someone else's conversation even
    // where the policy allowed it.
    render(<QuestionTurn {...base} canEdit={false} />);
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
  });

  it("does not offer an edit while a reply is still arriving", () => {
    render(<QuestionTurn {...base} busy />);
    expect(screen.getByRole("button", { name: /edit/i })).toBeDisabled();
  });

  it("draws whatever the caller hangs underneath", async () => {
    // A slot, not a prop shaped like uploads. What goes here is "the receipts
    // for files still going up, under the LAST question only" — a condition
    // about the list, which this component cannot see and should not learn.
    render(<QuestionTurn {...base} footer={<span>report.pdf · 40%</span>} />);
    expect(await screen.findByText("report.pdf · 40%")).toBeInTheDocument();
  });

  it("keeps the edit reachable without a mouse", async () => {
    // Failure mode #5: the row is revealed on hover, so focus has to reveal it
    // too or it does not exist for a keyboard.
    //
    // Two assertions because neither is enough alone. Tabbing to it proves it
    // is in the tab order — but a focused element at `opacity: 0` is focused
    // and invisible, and jsdom evaluates no cascade, so the only handle on the
    // second half is the class that does the revealing.
    const { container } = render(<QuestionTurn {...base} />);
    await userEvent.tab();

    expect(screen.getByRole("button", { name: /edit/i })).toHaveFocus();
    expect(meta(container)).toHaveClass("focus-within:opacity-100");
  });

  it("keeps the time and the edit there at all on a screen with no hover", () => {
    // The other half of failure mode #5, and the one usually missed. A phone
    // has no hover: `group-hover` alone means the timestamp does not exist on
    // a touch device, and neither does the only way to fix a typo.
    const { container } = render(<QuestionTurn {...base} />);
    expect(meta(container)).toHaveClass("[@media(hover:none)]:opacity-100");
  });

  /**
   * The redesign, as three claims about one element.
   *
   * The question used to be the heaviest object on the screen — `bg-primary`,
   * which is ink — so the eye went to what the reader had typed rather than to
   * the answer underneath. The reference this was built against has it the
   * other way round, and so does every chat product people arrive from.
   */
  it("fills the bubble with its own colour rather than with ink", () => {
    const { container } = render(<QuestionTurn {...base} />);
    expect(bubble(container)).toHaveClass("bg-bubble");
    expect(bubble(container)).not.toHaveClass("bg-primary");
  });

  it("has no tail, and no fixed width to fill", () => {
    // `rounded-br-sm` was a speech-bubble tail pointing at nobody — there is no
    // avatar on that side to point at. And a 560px minimum-looking slab made a
    // four-word question draw a box the size of a paragraph.
    const { container } = render(<QuestionTurn {...base} />);
    expect(bubble(container)?.className).not.toMatch(/rounded-br/);
    expect(bubble(container)?.className).not.toMatch(/max-w-\[\d+px\]/);
  });

  it("puts the time above the bubble, where it is out of the way of the next turn", () => {
    // It was underneath, between this question and the answer to it — the one
    // gap in the transcript that has to read as "these two belong together".
    // Above, it sits in the gap that already separates one exchange from the
    // last.
    const { container } = render(<QuestionTurn {...base} />);
    const order = [...(container.firstElementChild?.children ?? [])];
    expect(order.indexOf(meta(container)!)).toBeLessThan(order.indexOf(bubble(container)!));
  });
});
