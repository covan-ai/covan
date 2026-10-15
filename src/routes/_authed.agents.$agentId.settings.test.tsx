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
  user: { id: "u1", name: "Ada" },
  workspace: { id: "w1", name: "Acme" },
  members: [
    { id: "u1", name: "Ada", email: "ada@acme.test", role: "member", avatarUrl: null },
    { id: "u2", name: "Grace Hopper", email: "grace@acme.test", role: "member", avatarUrl: null },
  ],
  models: ["gpt-4o", "gpt-5-mini", "claude-sonnet-4-6"],
  modelSpecs: {
    "gpt-4o": { temperature: true, reasoning: false, webSearch: false },
    "gpt-5-mini": { temperature: false, reasoning: true, webSearch: false },
    "claude-sonnet-4-6": { temperature: true, reasoning: true, webSearch: true },
  },
};

vi.mock("@/lib/api-client", () => ({ api: { me: () => Promise.resolve(me) } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/saved-logins", () => ({
  SavedLoginsList: ({ agentId }: { agentId?: string }) => (
    <p data-testid="saved-logins">{agentId}</p>
  ),
}));
vi.mock("@/components/generate-persona-button", () => ({
  GeneratePersonaButton: () => null,
}));
// The dialog has tests of its own; here the question is only who gets to open it.
vi.mock("@/components/share-agent-dialog", () => ({
  ShareAgentDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="share-dialog" /> : null,
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
  webSearch: true,
  documents: [],
  bundleIds: [],
  createdAt: Date.parse("2026-09-01T10:00:00Z"),
  createdBy: "u1" as string | null,
  workspaceAccess: null as string | null,
  shares: [] as { userId: string; access: string }[],
  myAccess: "manage" as "use" | "edit" | "manage",
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
  agent.webSearch = true;
  agent.createdBy = "u1";
  agent.workspaceAccess = null;
  agent.shares = [];
  agent.myAccess = "manage";
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

describe("web search", () => {
  it("is offered on a model that can search", async () => {
    agent.model = "claude-sonnet-4-6";
    renderSettings();

    // Waited for by the hint, which only reads this way once /me has said the
    // model has a search tool; before that every model is assumed not to.
    expect(await screen.findByText(/Allow this agent to search the internet/)).toBeInTheDocument();
    expect(screen.getByLabelText("Enable web search")).toBeEnabled();
    expect(screen.getByLabelText("Enable web search")).toBeChecked();
  });

  it("says why it is dead on a model that cannot search, and keeps what was stored", async () => {
    // gpt-4o is sent no search tool, so a checked box here was a promise
    // nothing kept. Disabled, not hidden, and not unticked: the agent's own
    // setting is still there for the day it moves back to a model that can.
    renderSettings();

    expect(await screen.findByText(/cannot search the web/)).toBeInTheDocument();
    expect(screen.getByLabelText("Enable web search")).toBeDisabled();
    expect(screen.getByLabelText("Enable web search")).toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(updateAgent).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ webSearch: true }),
    );
  });
});

describe("saved logins", () => {
  /** Task 2.4: the agent's settings show the logins it signs in with, for this agent only. */
  it("shows this agent's saved logins", async () => {
    renderSettings();

    expect(await screen.findByText("Saved logins")).toBeInTheDocument();
    expect(screen.getByTestId("saved-logins")).toHaveTextContent("agent-1");
  });

  /** Final review #5: scoped to what Covan controls — its own model. */
  it("says Covan's AI model is never given them", async () => {
    renderSettings();

    expect(
      await screen.findByText(
        "What this agent's browser signs in with. Encrypted; Covan's AI model is never given them.",
      ),
    ).toBeInTheDocument();
  });
});

// 0104: what the screen offers follows the caller's access to THIS agent, not
// their role in the workspace. A control the server would refuse is not drawn.
describe("access to this agent", () => {
  it("shows somebody who can only use it the settings, and nothing to change them with", async () => {
    agent.myAccess = "use";
    agent.createdBy = "u2";
    agent.workspaceAccess = "use";
    renderSettings();

    expect(
      await screen.findByText("This is how the agent is set up.", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    expect(screen.queryByText("Danger zone")).not.toBeInTheDocument();
    expect(screen.getByText("Can use")).toBeInTheDocument();
  });

  it("lets somebody who can edit it save, but not share or delete it", async () => {
    agent.myAccess = "edit";
    agent.createdBy = "u2";
    agent.workspaceAccess = "edit";
    renderSettings();

    expect(await screen.findByRole("button", { name: "Save changes" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    expect(screen.queryByText("Danger zone")).not.toBeInTheDocument();
    expect(screen.getByText("Everyone · Can edit")).toBeInTheDocument();
  });

  it("gives Full access the Share button and the Danger zone", async () => {
    renderSettings();

    expect(await screen.findByText("Only you")).toBeInTheDocument();
    expect(screen.getByText("Danger zone")).toBeInTheDocument();
    expect(screen.queryByTestId("share-dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Share" }));

    expect(screen.getByTestId("share-dialog")).toBeInTheDocument();
  });

  it("names how many people it is shared with", async () => {
    agent.shares = [{ userId: "u2", access: "use" }];
    renderSettings();

    expect(await screen.findByText("1 person")).toBeInTheDocument();
    // The faces come from /me, which answers after the first render.
    expect(await screen.findByText("GH")).toBeInTheDocument();
  });
});
