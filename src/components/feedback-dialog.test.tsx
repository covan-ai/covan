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

const { FeedbackDialog } = await import("./feedback-dialog");

const box = () => screen.getByLabelText(/what happened/i);
const sendButton = () => screen.getByRole("button", { name: /^send$/i });

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue({ id: "f1", createdAt: 0 });
});

describe("feedback about one answer", () => {
  /**
   * The chat's thumbs used to fill in an icon and raise a toast saying "Thanks
   * for the feedback" while storing nothing anywhere. They now open this, and
   * the id of the answer is the part the person should not have to describe.
   */
  it("carries the answer it was opened from", async () => {
    const user = userEvent.setup();
    render(
      <FeedbackDialog
        open
        onOpenChange={() => {}}
        path="/agents/a1/chat"
        about={{ messageId: "m-1", label: "Sales Assistant's answer" }}
        initialKind="problem"
      />,
    );

    await user.type(box(), "it invented a refund window");
    await user.click(sendButton());

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        message: "it invented a refund window",
        kind: "problem",
        path: "/agents/a1/chat",
        messageId: "m-1",
      }),
    );
  });

  it("says which answer it is about", () => {
    render(
      <FeedbackDialog
        open
        onOpenChange={() => {}}
        path="/agents/a1/chat"
        about={{ messageId: "m-1", label: "Sales Assistant's answer" }}
      />,
    );

    expect(screen.getByText(/sales assistant's answer/i)).toBeInTheDocument();
  });

  it("starts on the kind it was opened with", () => {
    render(<FeedbackDialog open onOpenChange={() => {}} path="/app" initialKind="problem" />);

    expect(screen.getByRole("button", { name: /something's broken/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("sends no answer id when it was not opened from one", async () => {
    const user = userEvent.setup();
    render(<FeedbackDialog open onOpenChange={() => {}} path="/app" />);

    await user.type(box(), "the sidebar is cramped");
    await user.click(sendButton());

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.not.objectContaining({ messageId: expect.anything() }),
      ),
    );
  });
});
