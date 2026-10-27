import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

/**
 * An agent's Configuration (A10): one draft for the page, saved or discarded
 * from the top bar, and what it offers following the caller's access to this
 * agent (0104).
 *
 * The tuning controls are where a null and a number mean different things:
 * Auto is not a value on the slider — it means the mode decides — so a form
 * that quietly resolved it to a number would change every reply the first time
 * anybody saved.
 */

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => ({
    ...options,
    useParams: () => ({ agentId: "agent-1" }),
  }),
  useNavigate: () => vi.fn(),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const me = {
  user: { id: "u1", name: "Ada" },
  workspace: { id: "w1", name: "Acme" },
  members: [
    { id: "u1", name: "Ada Lovelace", email: "ada@acme.test", role: "member", avatarUrl: null },
    { id: "u2", name: "Grace Hopper", email: "grace@acme.test", role: "member", avatarUrl: null },
  ],
  models: ["gpt-4o", "gpt-5-mini", "claude-sonnet-4-6"],
  modelSpecs: {
    "gpt-4o": { temperature: true, reasoning: false, webSearch: false },
    "gpt-5-mini": { temperature: false, reasoning: true, webSearch: false },
    "claude-sonnet-4-6": { temperature: true, reasoning: true, webSearch: true },
  },
};

const deleteSummary = vi.fn(async (_id: string) => ({ threads: 19, routines: 2, folders: 3 }));
vi.mock("@/lib/api-client", () => ({
  api: {
    me: () => Promise.resolve(me),
    modelEndpoints: { list: async () => [] },
    agents: { deleteSummary: (id: string) => deleteSummary(id) },
  },
  ApiError: class ApiError extends Error {},
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/top-bar", () => ({
  TopBarPortal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
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
const toolConnections = {
  data: {
    connections: [
      {
        id: "conn-1",
        label: "Gmail",
        transport: "composio",
        toolkitSlug: "gmail",
        status: "active",
        allowedMethods: ["GET"],
      },
    ],
  },
};
vi.mock("@/hooks/use-connections", () => ({
  useToolConnections: () => toolConnections,
  useConnectionGrants: () => ({ data: { grants: [] } }),
}));

const updateAgent = vi.fn();
const agent = {
  id: "agent-1",
  name: "GTM Agent",
  emoji: "📈",
  avatar: "fox" as string | null,
  model: "gpt-4o",
  persona: "You are our PM.",
  mode: "normal" as const,
  temperature: null as number | null,
  reasoningEffort: null as string | null,
  webSearch: true,
  browserOff: false,
  connectionsOff: [] as string[],
  documents: [],
  bundleIds: ["b1"],
  createdAt: Date.parse("2026-09-01T10:00:00Z"),
  createdBy: "u1" as string | null,
  workspaceAccess: null as string | null,
  shares: [] as { userId: string; access: string }[],
  myAccess: "manage" as "use" | "edit" | "manage",
};
const store = {
  agents: [agent],
  bundles: [{ id: "b1", name: "Policies", description: null, documentCount: 9, createdAt: 0 }],
  updateAgent,
  deleteAgent: vi.fn(),
  attachBundle: vi.fn(),
  detachBundle: vi.fn(),
  canWrite: true,
};

vi.mock("@/lib/agents-store", () => ({ useAgentsStore: () => store }));

const { Route } = await import("./_authed.agents.$agentId.configuration");

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Component = (Route as unknown as { component: () => React.ReactElement }).component;
  return render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
}

/** Anything, so Save has something to save. */
async function touchName() {
  const name = await screen.findByLabelText("Name");
  await userEvent.type(name, "!");
}

beforeEach(() => {
  updateAgent.mockClear();
  agent.model = "gpt-4o";
  agent.temperature = null;
  agent.reasoningEffort = null;
  agent.webSearch = true;
  agent.browserOff = false;
  agent.connectionsOff = [];
  agent.createdBy = "u1";
  agent.workspaceAccess = null;
  agent.shares = [];
  agent.myAccess = "manage";
});

describe("the draft", () => {
  it("offers nothing to save or discard until something changed", async () => {
    renderSettings();
    expect(await screen.findByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();

    await touchName();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByLabelText("Name")).toHaveValue("GTM Agent");
  });

  it("says when it was saved", async () => {
    renderSettings();
    await touchName();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(updateAgent).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ name: "GTM Agent!" }),
    );
    expect(screen.getByText("Saved just now")).toBeInTheDocument();
  });
});

describe("the tuning controls", () => {
  it("starts on Auto, with no number on screen to argue with", async () => {
    renderSettings();

    expect(await screen.findByLabelText("Auto")).toBeChecked();
    expect(screen.queryByLabelText("Temperature")).not.toBeInTheDocument();
  });

  it("saves null for a setting nobody touched", async () => {
    // Opening Configuration and saving something else must not move an agent
    // off the behaviour it has had since it was created.
    renderSettings();
    await touchName();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(updateAgent).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ temperature: null, reasoningEffort: null }),
    );
  });

  it("offers a number to adjust once Auto is turned off, and saves it", async () => {
    renderSettings();

    await userEvent.click(await screen.findByLabelText("Auto"));
    // 0.7 rather than 0: a slider that opens at one end reads as "off".
    expect(screen.getByLabelText("Temperature")).toHaveValue("0.7");

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
    agent.model = "gpt-5-mini";
    renderSettings();

    expect(await screen.findByText(/rejects any other value/)).toBeInTheDocument();
    expect(screen.getByLabelText("Auto")).toBeDisabled();
  });

  it("says why thinking is dead on a model that does not reason", async () => {
    renderSettings();
    expect(await screen.findByText(/answers without a separate thinking step/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Thinking" })).toBeDisabled();
  });
});

describe("tools", () => {
  it("offers web search on a model that can search", async () => {
    agent.model = "claude-sonnet-4-6";
    renderSettings();

    expect(await screen.findByText(/documents don't have the answer/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Web search" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Web search" })).toBeChecked();
  });

  it("says why web search is dead on a model that cannot, and keeps what was stored", async () => {
    renderSettings();

    expect(await screen.findByText(/cannot search the web/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Web search" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Web search" })).toBeChecked();
  });

  it("switches the browser and a connected app off, as what is off", async () => {
    renderSettings();

    await userEvent.click(await screen.findByRole("switch", { name: "Browser" }));
    await userEvent.click(screen.getByRole("switch", { name: "Gmail" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(updateAgent).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ browserOff: true, connectionsOff: ["conn-1"] }),
    );
  });
});

describe("knowledge and sign-ins", () => {
  it("names the folders it reads and offers to attach another", async () => {
    renderSettings();
    expect(await screen.findByText("Policies")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Attach folder" }));
    expect(
      within(screen.getByRole("dialog")).getByRole("switch", { name: "GTM Agent reads Policies" }),
    ).toBeChecked();
  });

  it("shows this agent's saved sign-ins", async () => {
    renderSettings();
    expect(await screen.findByTestId("saved-logins")).toHaveTextContent("agent-1");
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
    expect(screen.queryByText("Danger")).not.toBeInTheDocument();
    expect(screen.getByText("Can use")).toBeInTheDocument();
    expect(await screen.findByText("Everyone in Acme")).toBeInTheDocument();
  });

  it("lets somebody who can edit it save, but not share or delete it", async () => {
    agent.myAccess = "edit";
    agent.createdBy = "u2";
    agent.workspaceAccess = "edit";
    renderSettings();

    expect(await screen.findByRole("button", { name: "Save changes" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    expect(screen.queryByText("Danger")).not.toBeInTheDocument();
  });

  it("gives Full access the Share button and Delete, with what a delete takes", async () => {
    renderSettings();

    expect(await screen.findByText("Only you")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(screen.getByTestId("share-dialog")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Delete GTM Agent…" }));
    expect(
      await screen.findByText(/Its 19 threads stay readable for 30 days under Recently deleted/),
    ).toBeInTheDocument();
    expect(deleteSummary).toHaveBeenCalledWith("agent-1");
  });

  it("names who else may edit it", async () => {
    agent.shares = [{ userId: "u2", access: "edit" }];
    renderSettings();
    expect(await screen.findByText("Admins and you and Grace")).toBeInTheDocument();
  });
});

describe("the model", () => {
  it("offers the tiers as rows once the install serves one, and a specific model besides", async () => {
    const before = me.models;
    me.models = [...before, "claude-sonnet-5"];
    try {
      renderSettings();

      const standard = await screen.findByRole("radio", { name: /Standard/ });
      expect(standard).toHaveAttribute("aria-checked", "false");
      // gpt-4o is no tier, so it is pinned as a specific model.
      expect(screen.getByRole("radio", { name: /A specific model/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(screen.getByText("All models")).toBeInTheDocument();

      await userEvent.click(standard);
      expect(screen.getByRole("radio", { name: /Standard/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(screen.getByRole("radio", { name: /A specific model/ })).toHaveAttribute(
        "aria-checked",
        "false",
      );
    } finally {
      me.models = before;
    }
  });
});
