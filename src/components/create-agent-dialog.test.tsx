import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  createAgent: vi.fn(),
  navigate: vi.fn(),
  trackStep: vi.fn(),
  flushEvents: vi.fn(async () => {}),
  agents: [] as Array<{ avatar: string | null }>,
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => h.navigate }));
vi.mock("@/lib/api-client", () => ({
  api: {
    me: async () => ({
      user: { id: "u1" },
      workspace: { name: "Acme", defaultModel: null },
      models: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"],
      modelCredits: { "claude-haiku-4-5": 1, "claude-sonnet-5": 2, "claude-opus-5": 6 },
    }),
  },
}));
vi.mock("@/lib/agents-store", () => ({
  useAgentsStore: () => ({ agents: h.agents, createAgent: h.createAgent }),
}));
vi.mock("@/lib/analytics", () => ({ trackStep: h.trackStep, flushEvents: h.flushEvents }));
vi.mock("@/components/generate-persona-button", () => ({ GeneratePersonaButton: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CreateAgentDialog } from "./create-agent-dialog";
import type { CreateAgentInitial } from "@/lib/shell";

function renderDialog(initial?: CreateAgentInitial) {
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CreateAgentDialog open onOpenChange={onOpenChange} initial={initial} />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

beforeEach(() => {
  h.createAgent.mockReset().mockResolvedValue({ id: "a9", name: "Research" });
  h.navigate.mockReset();
  h.trackStep.mockReset();
  h.agents = [];
});

describe("CreateAgentDialog", () => {
  it("is one step: a name, a face, what it does, a model and who can use it", () => {
    renderDialog();
    expect(screen.getByRole("heading", { name: "New agent" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Face" })).toBeInTheDocument();
    expect(screen.getByLabelText("What it does")).toBeInTheDocument();
    expect(screen.getByText("Only you can use it until you share it.")).toBeInTheDocument();
    expect(screen.queryByText(/template/i)).not.toBeInTheDocument();
  });

  it("starts on a face nobody here wears yet", () => {
    h.agents = [{ avatar: "headset" }, { avatar: "fox" }];
    renderDialog();
    expect(screen.getByRole("radio", { name: /owl/i })).toHaveAttribute("aria-checked", "true");
  });

  it("creates it private, on its face, and opens its first thread", async () => {
    const onOpenChange = renderDialog();
    await userEvent.type(screen.getByLabelText("Name"), "Research");
    await userEvent.click(screen.getByRole("radio", { name: /bear/i }));
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));

    expect(h.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Research",
        avatar: "bear",
        sharing: { workspaceAccess: null, shares: [] },
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(h.navigate).toHaveBeenCalledWith({
      to: "/agents/$agentId/chat",
      params: { agentId: "a9" },
    });
  });

  it("will not create an agent with no name", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Create agent" })).toBeDisabled();
  });

  // An agent card on the use-cases page: the form starts filled in, still
  // editable, and the create is counted under the card's step.
  it("starts from a use case and counts the create under it", async () => {
    renderDialog({
      name: "Sparring partner",
      avatar: "owl",
      persona: "You take the other side.",
      mode: "brainstorm",
      webSearch: false,
      trackAs: "use-case:sparring",
    });
    expect(screen.getByLabelText("Name")).toHaveValue("Sparring partner");
    expect(screen.getByLabelText("What it does")).toHaveValue("You take the other side.");
    expect(screen.getByRole("radio", { name: /owl/i })).toHaveAttribute("aria-checked", "true");

    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));

    expect(h.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Sparring partner",
        avatar: "owl",
        persona: "You take the other side.",
        mode: "brainstorm",
        webSearch: false,
      }),
    );
    expect(h.trackStep).toHaveBeenCalledWith("use-case:sparring", "completed");
    expect(h.flushEvents).toHaveBeenCalled();
  });

  it("counts nothing for an agent made from scratch", async () => {
    renderDialog();
    await userEvent.type(screen.getByLabelText("Name"), "Research");
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(h.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "normal", webSearch: true }),
    );
    expect(h.trackStep).not.toHaveBeenCalled();
  });
});
