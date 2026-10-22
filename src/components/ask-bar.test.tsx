import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const startSession = vi.fn();
vi.mock("@/lib/agents-store", () => ({ useAgentsStore: () => ({ startSession }) }));

const uploads = {
  receipts: [] as Array<{ id: string; name: string; state: string; progress: number }>,
  addFiles: vi.fn(),
  remove: vi.fn(),
  dismiss: vi.fn(),
};
vi.mock("@/lib/use-chat-uploads", () => ({ useChatUploads: () => uploads }));

import { AskBar } from "./ask-bar";

const support = { id: "a1", name: "Support", avatar: "headset" } as never;
const research = { id: "a2", name: "Research", avatar: "owl" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  uploads.receipts = [];
  startSession.mockResolvedValue({ id: "s1" });
});

describe("AskBar", () => {
  it("starts a thread with the agent, leaves the words for it, and opens it", async () => {
    render(<AskBar agents={[support, research]} selected={support} onSelect={vi.fn()} />);
    const input = screen.getByLabelText("Ask an agent");
    expect(input).toHaveAttribute("placeholder", "Ask Support…");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    await userEvent.type(input, "Where is the refund policy?{Enter}");

    expect(startSession).toHaveBeenCalledWith("a1");
    expect(sessionStorage.getItem("chat-draft:s1")).toBe("Where is the refund policy?");
    expect(navigate).toHaveBeenCalledWith({
      to: "/agents/$agentId/chat",
      params: { agentId: "a1" },
      search: { s: "s1" },
    });
  });

  it("changes the agent from the picker", async () => {
    const onSelect = vi.fn();
    render(<AskBar agents={[support, research]} selected={support} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: /ask support\. change agent/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /research/i }));
    expect(onSelect).toHaveBeenCalledWith("a2");
  });

  it("sends a file without words once it is in, and holds the agent while it goes", () => {
    uploads.receipts = [{ id: "r1", name: "nda.pdf", state: "uploading", progress: 40 }];
    const { rerender } = render(
      <AskBar agents={[support, research]} selected={support} onSelect={vi.fn()} />,
    );
    expect(screen.getByText("40%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /ask support\. change agent/i })).toBeDisabled();

    uploads.receipts = [{ id: "r1", name: "nda.pdf", state: "done", progress: 100 }];
    rerender(<AskBar agents={[support, research]} selected={support} onSelect={vi.fn()} />);
    expect(screen.getByText("added")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("hands picked files to the agent's chat folder", async () => {
    render(<AskBar agents={[support]} selected={support} onSelect={vi.fn()} />);
    const file = new File(["x"], "nda.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText("Choose files to attach"), file);
    expect(uploads.addFiles).toHaveBeenCalledWith([file]);
  });
});
