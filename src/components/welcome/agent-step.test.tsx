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
    render(<AgentStep useCase="code" defaultModel={null} onDone={vi.fn()} />);

    // "code" maps to the coding template, whose persona opens on being a senior
    // software engineer.
    const persona = screen.getByLabelText(/persona/i) as HTMLTextAreaElement;
    expect(persona.value).toContain("senior software engineer");
  });

  it("finishes without creating anything when skipped", async () => {
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<AgentStep useCase="code" defaultModel={null} onDone={onDone} />);

    await user.click(screen.getByRole("button", { name: /later/i }));

    expect(createAgent).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });
});
