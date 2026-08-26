import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KnowledgeStep } from "./knowledge-step";
import type { Agent } from "@/lib/agents-store";

// Hoisted, because `vi.mock` factories run before top-level consts exist and
// the api-client factory reads its member eagerly rather than on call.
const { createBundle, uploadToBundle, attach, invalidateQueries } = vi.hoisted(() => ({
  createBundle: vi.fn(),
  uploadToBundle: vi.fn(),
  attach: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@/lib/agents-store", () => ({
  useAgentsStore: () => ({ createBundle, uploadToBundle }),
}));

vi.mock("@/lib/api-client", () => ({ api: { bundles: { attach } } }));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const AGENT = { id: "agent-1", name: "GTM Agent" } as Agent;

function file(name: string, contents = "hello") {
  return new File([contents], name, { type: "text/plain" });
}

beforeEach(() => {
  vi.clearAllMocks();
  createBundle.mockImplementation(async (name: string) => ({ id: "bundle-1", name }));
  uploadToBundle.mockResolvedValue({ id: "doc-1", indexed: true });
  attach.mockResolvedValue(undefined);
  invalidateQueries.mockResolvedValue(undefined);
});

describe("KnowledgeStep", () => {
  it("moves on without touching anything when skipped", async () => {
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<KnowledgeStep agent={AGENT} onDone={onDone} />);

    await user.click(screen.getByRole("button", { name: /later/i }));

    expect(createBundle).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it("treats an empty submission as the same answer as skipping", async () => {
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<KnowledgeStep agent={AGENT} onDone={onDone} />);

    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(createBundle).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it("puts the documents in a bundle named after the agent and attaches it", async () => {
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<KnowledgeStep agent={AGENT} onDone={onDone} />);

    await user.upload(screen.getByLabelText(/documents for gtm agent/i), file("handbook.md"));
    await user.click(screen.getByRole("button", { name: /add 1 document/i }));

    expect(createBundle).toHaveBeenCalledWith("GTM Agent knowledge");
    // A bundle that was never attached is a document the agent cannot read,
    // which would make this whole step decorative.
    expect(attach).toHaveBeenCalledWith("agent-1", "bundle-1");
    expect(uploadToBundle).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalled();
  });

  it("refuses a file type the server would refuse anyway", async () => {
    const user = userEvent.setup();
    render(<KnowledgeStep agent={AGENT} onDone={vi.fn()} />);

    await user.upload(screen.getByLabelText(/documents for gtm agent/i), file("virus.exe"));

    // Nothing queued, so the button still offers the empty-handed way out.
    expect(screen.queryByText("virus.exe")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue/i })).toBeInTheDocument();
  });

  it("lets a file picked by mistake be taken back out", async () => {
    const user = userEvent.setup();
    render(<KnowledgeStep agent={AGENT} onDone={vi.fn()} />);

    await user.upload(screen.getByLabelText(/documents for gtm agent/i), file("notes.txt"));
    expect(screen.getByText("notes.txt")).toBeInTheDocument();

    await user.click(screen.getByLabelText(/remove notes\.txt/i));

    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();
  });

  it("carries on to the app when the upload fails", async () => {
    // The agent exists and the Knowledge tab is built for retrying. Holding
    // someone on the last screen of a signup over it would be the worse trade.
    uploadToBundle.mockRejectedValueOnce(new Error("network"));
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<KnowledgeStep agent={AGENT} onDone={onDone} />);

    await user.upload(screen.getByLabelText(/documents for gtm agent/i), file("handbook.md"));
    await user.click(screen.getByRole("button", { name: /add 1 document/i }));

    expect(onDone).toHaveBeenCalled();
  });
});
