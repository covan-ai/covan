import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { send, toastSuccess, toastError } = vi.hoisted(() => ({
  send: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({ api: { feedback: { send } } }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

const { FeedbackButton } = await import("./feedback-button");

async function open(path = "/app") {
  const user = userEvent.setup();
  render(<FeedbackButton path={path} />);
  await user.click(screen.getByRole("button", { name: /send feedback/i }));
  return user;
}

const box = () => screen.getByLabelText(/what happened/i);
const sendButton = () => screen.getByRole("button", { name: /^send$/i });

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue({ id: "f1", createdAt: 0 });
});

describe("the feedback button", () => {
  it("opens a box to write in", async () => {
    await open();

    expect(box()).toBeInTheDocument();
  });

  /**
   * The dialog claims two things about where this goes, and both have to stay
   * true of the schema in 0041: only the operator reads it, and no reply is
   * coming. A feedback box that implies a conversation it cannot have is worse
   * than no box.
   */
  it("says who reads it and that no reply is coming", async () => {
    await open();

    expect(screen.getByText(/whoever runs (this )?covan|runs this install/i)).toBeInTheDocument();
    expect(screen.getByText(/no reply|won't reply|not a reply/i)).toBeInTheDocument();
  });

  it("has nothing to send until something is written", async () => {
    await open();

    expect(sendButton()).toBeDisabled();
  });

  it("sends what was written, with the page it was written from", async () => {
    const user = await open("/agents/abc/knowledge");

    await user.type(box(), "the upload spinner never stops");
    await user.click(sendButton());

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        message: "the upload spinner never stops",
        kind: "other",
        path: "/agents/abc/knowledge",
      }),
    );
  });

  it("carries the kind that was picked", async () => {
    const user = await open();

    await user.click(screen.getByRole("button", { name: /something's broken/i }));
    await user.type(box(), "it broke");
    await user.click(sendButton());

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: "problem" })),
    );
  });

  it("closes and thanks you once it is recorded", async () => {
    const user = await open();

    await user.type(box(), "nice work");
    await user.click(sendButton());

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByLabelText(/what happened/i)).not.toBeInTheDocument());
  });

  /**
   * The one that matters when it goes wrong. Somebody who just typed three
   * paragraphs about a bug and hit a 500 must not lose them — a dialog that
   * closes on failure is a dialog that eats the report it was collecting.
   */
  it("keeps what was written when the send fails", async () => {
    send.mockRejectedValue(new Error("nope"));
    const user = await open();

    await user.type(box(), "three paragraphs of hard-won detail");
    await user.click(sendButton());

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(box()).toHaveValue("three paragraphs of hard-won detail");
  });

  it("starts empty the next time it is opened", async () => {
    const user = await open();

    await user.type(box(), "sent and done");
    await user.click(sendButton());
    await waitFor(() => expect(screen.queryByLabelText(/what happened/i)).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /send feedback/i }));

    expect(box()).toHaveValue("");
  });
});
