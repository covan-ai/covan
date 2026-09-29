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
    // Failure mode #5: the button is revealed on hover, so focus has to reveal
    // it too or it does not exist for a keyboard.
    //
    // Two assertions because neither is enough alone. Tabbing to it proves it
    // is in the tab order — but a focused element at `opacity: 0` is focused
    // and invisible, and jsdom evaluates no cascade, so the only handle on the
    // second half is the class that does it.
    render(<QuestionTurn {...base} />);
    await userEvent.tab();

    const edit = screen.getByRole("button", { name: /edit/i });
    expect(edit).toHaveFocus();
    expect(edit).toHaveClass("focus-visible:opacity-100");
  });
});
