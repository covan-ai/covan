import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentStep } from "./agent-step";

const createAgent = vi.fn(async () => ({ id: "agent-1" }));

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
});
