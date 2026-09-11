import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

/**
 * The two tuning controls, which are the part of this screen where a null and a
 * number mean different things.
 *
 * Auto is not a value on the slider — it means the mode decides, which is 0.9
 * in brainstorm and nothing at all in normal chat. Every agent is on it, so a
 * form that quietly resolved it to a number would change every reply in the
 * product the first time anybody opened Settings and pressed Save.
 */

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => ({
    ...options,
    useParams: () => ({ agentId: "agent-1" }),
  }),
  useNavigate: () => vi.fn(),
}));

const me = {
  models: ["gpt-4o", "gpt-5-mini"],
  modelSpecs: {
    "gpt-4o": { temperature: true, reasoning: false },
    "gpt-5-mini": { temperature: false, reasoning: true },
  },
};

vi.mock("@/lib/api-client", () => ({ api: { me: () => Promise.resolve(me) } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/generate-persona-button", () => ({
  GeneratePersonaButton: () => null,
}));

const updateAgent = vi.fn();
const agent = {
  id: "agent-1",
  name: "GTM Agent",
  emoji: "📈",
  model: "gpt-4o",
  persona: "You are our PM.",
  mode: "normal" as const,
  temperature: null as number | null,
  reasoningEffort: null as string | null,
  documents: [],
  bundleIds: [],
  createdAt: Date.parse("2026-09-01T10:00:00Z"),
};
const store = { agents: [agent], updateAgent, deleteAgent: vi.fn(), canWrite: true };

vi.mock("@/lib/agents-store", () => ({ useAgentsStore: () => store }));

const { Route } = await import("./_authed.agents.$agentId.settings");

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Component = (Route as unknown as { component: () => React.ReactElement }).component;
  return render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  updateAgent.mockClear();
  agent.model = "gpt-4o";
  agent.temperature = null;
  agent.reasoningEffort = null;
});

describe("the tuning controls", () => {
  it("starts on Auto, with no number on screen to argue with", async () => {
    renderSettings();

    expect(await screen.findByLabelText("Auto")).toBeChecked();
    expect(screen.queryByLabelText("Temperature")).not.toBeInTheDocument();
  });

  it("saves null for a setting nobody touched", async () => {
    // The important one. Opening Settings and pressing Save must not move an
    // agent off the behaviour it has had since it was created.
    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Save changes" }));

    expect(updateAgent).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ temperature: null, reasoningEffort: null }),
    );
  });

  it("offers a number to adjust once Auto is turned off", async () => {
    renderSettings();

    await userEvent.click(await screen.findByLabelText("Auto"));

    // 0.7 rather than 0: a slider that opens at one end reads as "off", and the
    // extreme it landed on is never the value somebody meant.
    expect(screen.getByLabelText("Temperature")).toHaveValue("0.7");
    expect(screen.getByText("0.7")).toBeInTheDocument();
  });

  it("saves the number the slider is on", async () => {
    renderSettings();

    await userEvent.click(await screen.findByLabelText("Auto"));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(updateAgent).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ temperature: 0.7 }),
    );
  });

  it("keeps a temperature the agent already had", async () => {
    agent.temperature = 0.2;
    renderSettings();

    expect(await screen.findByLabelText("Temperature")).toHaveValue("0.2");
    expect(screen.getByLabelText("Auto")).not.toBeChecked();
  });

  it("says why the control is dead on a model that decides for itself", async () => {
    // gpt-5-mini rejects any temperature but its own with a 400. A disabled
    // control that explains itself beats one that vanishes when the model picker
    // above it changes.
    agent.model = "gpt-5-mini";
    renderSettings();

    // Waited for by the explanation rather than by the control: the form
    // renders before /me answers, and until it does every model looks like it
    // takes a temperature.
    expect(await screen.findByText(/rejects any other value/)).toBeInTheDocument();
    expect(screen.getByLabelText("Auto")).toBeDisabled();
  });

  it("says why reasoning is dead on a model that does not reason", async () => {
    renderSettings();

    expect(await screen.findByText(/answers without a separate thinking step/)).toBeInTheDocument();
  });
});
