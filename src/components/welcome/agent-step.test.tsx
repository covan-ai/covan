import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentStep } from "./agent-step";

const createAgent = vi.fn(async (_input: unknown) => ({ id: "agent-1" }));

vi.mock("@/lib/agents-store", () => ({
  useAgentsStore: () => ({ createAgent }),
}));

// The persona button calls the API; the step under test does not care what it
// returns, only that it is offered.
vi.mock("@/components/generate-persona-button", () => ({
  GeneratePersonaButton: () => <button type="button">Rewrite from name</button>,
}));

describe("AgentStep", () => {
  it("starts from the template the survey chose", () => {
    render(<AgentStep useCase="code" defaultModel={null} onCreated={vi.fn()} onSkip={vi.fn()} />);

    // "code" maps to the coding template, whose persona opens on being a senior
    // software engineer.
    const persona = screen.getByLabelText(/persona/i) as HTMLTextAreaElement;
    expect(persona.value).toContain("senior software engineer");
  });

  it("finishes without creating anything when skipped", async () => {
    const onCreated = vi.fn();
    const onSkip = vi.fn();
    const user = userEvent.setup();
    render(<AgentStep useCase="code" defaultModel={null} onCreated={onCreated} onSkip={onSkip} />);

    await user.click(screen.getByRole("button", { name: /later/i }));

    expect(createAgent).not.toHaveBeenCalled();
    // The two exits are distinct on purpose — the step after this one only
    // makes sense when an agent was actually made.
    expect(onSkip).toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("reports a created agent through the exit the flow branches on", async () => {
    const onCreated = vi.fn();
    const onSkip = vi.fn();
    const user = userEvent.setup();
    render(<AgentStep useCase="code" defaultModel={null} onCreated={onCreated} onSkip={onSkip} />);

    await user.click(screen.getByRole("button", { name: /create agent/i }));

    expect(createAgent).toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("makes the first agent Only me unless somebody says otherwise", async () => {
    // The server's default too (0104), sent explicitly so the two cannot drift.
    createAgent.mockClear();
    const user = userEvent.setup();
    render(<AgentStep useCase="code" defaultModel={null} onCreated={vi.fn()} onSkip={vi.fn()} />);

    expect(screen.getByLabelText("Who can use it")).toHaveTextContent("Only me");
    await user.click(screen.getByRole("button", { name: /create agent/i }));

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ sharing: { workspaceAccess: null, shares: [] } }),
    );
  });

  it("shares it with the workspace when that is picked", async () => {
    createAgent.mockClear();
    const user = userEvent.setup();
    render(<AgentStep useCase="code" defaultModel={null} onCreated={vi.fn()} onSkip={vi.fn()} />);

    await user.click(screen.getByLabelText("Who can use it"));
    await user.click(await screen.findByRole("option", { name: "Whole workspace · Can edit" }));
    await user.click(screen.getByRole("button", { name: /create agent/i }));

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ sharing: { workspaceAccess: "edit", shares: [] } }),
    );
  });
});
