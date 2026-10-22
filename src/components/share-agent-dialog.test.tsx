import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The share dialog: three ways to reach an agent, and a list of people.
 *
 * What these pin down is what gets SENT — the server keeps whatever it is
 * given, so a dialog that showed Only me and sent last week's list would be a
 * dialog that lied about who can read somebody's agent.
 */

const me = {
  user: { id: "u1", name: "Ada Lovelace" },
  workspace: { id: "w1", name: "Acme" },
  members: [
    { id: "u1", name: "Ada Lovelace", email: "ada@acme.test", role: "member", avatarUrl: null },
    { id: "u2", name: "Grace Hopper", email: "grace@acme.test", role: "member", avatarUrl: null },
    { id: "u3", name: "Alan Turing", email: "alan@acme.test", role: "viewer", avatarUrl: null },
    { id: "u4", name: "Boss Person", email: "boss@acme.test", role: "admin", avatarUrl: null },
  ],
};

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

vi.mock("@/lib/api-client", () => ({ api: { me: () => Promise.resolve(me) }, ApiError }));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: (m: string) => toastError(m) } }));

const setSharing = vi.fn();
vi.mock("@/lib/agents-store", () => ({ useAgentsStore: () => ({ setSharing }) }));

const { ShareAgentDialog } = await import("./share-agent-dialog");

type Sharing = {
  workspaceAccess: "use" | "edit" | "manage" | null;
  shares: { userId: string; access: "use" | "edit" | "manage" }[];
};

function agent(sharing: Partial<Sharing> = {}) {
  return {
    id: "agent-1",
    name: "GTM Agent",
    emoji: "📈",
    model: "gpt-4o",
    persona: "",
    avatar: null,
    mode: "normal" as const,
    temperature: null,
    reasoningEffort: null,
    webSearch: false,
    documents: [],
    bundleIds: [],
    createdAt: 0,
    createdBy: "u1",
    workspaceAccess: null,
    shares: [],
    myAccess: "manage" as const,
    ...sharing,
  };
}

const onOpenChange = vi.fn();

async function renderDialog(sharing: Partial<Sharing> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ShareAgentDialog agent={agent(sharing)} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  // Everything below reads /me; wait for it rather than for a render.
  await screen.findByText("Ada Lovelace");
}

/** "Who can use it" says this, now. */
const usingIs = (text: string | RegExp) =>
  expect(screen.getByRole("combobox", { name: "Who can use it" })).toHaveTextContent(text);

async function choose(name: RegExp) {
  await userEvent.click(screen.getByRole("combobox", { name: "Who can use it" }));
  await userEvent.click(await screen.findByRole("option", { name }));
}

beforeEach(() => {
  setSharing.mockReset().mockResolvedValue({});
  toastError.mockReset();
  onOpenChange.mockReset();
});

describe("ShareAgentDialog", () => {
  it("opens on the choice the agent is already on", async () => {
    await renderDialog({ workspaceAccess: "edit" });

    usingIs(/^Everyone in /);
    expect(screen.getByLabelText("What everyone in the workspace can do")).toHaveTextContent(
      "Can edit",
    );
  });

  it("lists the owner and the admins as people who always have access", async () => {
    await renderDialog();

    const owner = screen.getByText("Ada Lovelace").closest("li")!;
    expect(within(owner).getByText("Owner")).toBeInTheDocument();
    expect(within(owner).getByText("(you)")).toBeInTheDocument();
    const admin = screen.getByText("Boss Person").closest("li")!;
    expect(within(admin).getByText("Admin · always has full access")).toBeInTheDocument();
  });

  it("sends nobody when it is switched to Only me, whoever was on the list", async () => {
    await renderDialog({ shares: [{ userId: "u2", access: "edit" }] });

    usingIs("Specific people");
    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();

    await choose(/^Only me/);
    expect(screen.queryByText("Grace Hopper")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(setSharing).toHaveBeenCalledWith("agent-1", { workspaceAccess: null, shares: [] });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("adds somebody from the picker, which offers neither the owner nor an admin", async () => {
    await renderDialog();

    await choose(/^Specific people/);
    await userEvent.click(screen.getByRole("button", { name: /add a person/i }));

    const picker = await screen.findByRole("listbox");
    expect(within(picker).queryByText("Ada Lovelace")).not.toBeInTheDocument();
    expect(within(picker).queryByText("Boss Person")).not.toBeInTheDocument();
    await userEvent.click(within(picker).getByText("Grace Hopper"));

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(setSharing).toHaveBeenCalledWith("agent-1", {
      workspaceAccess: null,
      shares: [{ userId: "u2", access: "use" }],
    });
  });

  it("changes one person's level", async () => {
    const user = userEvent.setup();
    await renderDialog({ shares: [{ userId: "u2", access: "use" }] });

    await user.click(screen.getByLabelText("What Grace Hopper can do"));
    await user.click(await screen.findByRole("option", { name: /^Full access/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(setSharing).toHaveBeenCalledWith("agent-1", {
      workspaceAccess: null,
      shares: [{ userId: "u2", access: "manage" }],
    });
  });

  it("starts somebody added over the workspace one level above everyone", async () => {
    // Adding a person at the level everybody already has would do nothing.
    await renderDialog({ workspaceAccess: "use" });

    await userEvent.click(screen.getByRole("button", { name: /add a person/i }));
    await userEvent.click(within(await screen.findByRole("listbox")).getByText("Grace Hopper"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(setSharing).toHaveBeenCalledWith("agent-1", {
      workspaceAccess: "use",
      shares: [{ userId: "u2", access: "edit" }],
    });
  });

  it("says when a viewer's share is above what a viewer can have", async () => {
    await renderDialog({ shares: [{ userId: "u3", access: "edit" }] });

    const row = screen.getByText("Alan Turing").closest("li")!;
    expect(within(row).getByText("Viewers can only use agents")).toBeInTheDocument();
  });

  it("shows the server's reason and stays open when it refuses", async () => {
    setSharing.mockRejectedValue(
      new ApiError(400, "that person is not a member of this workspace"),
    );
    await renderDialog();

    await choose(/^Everyone in /);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(setSharing).toHaveBeenCalledWith("agent-1", { workspaceAccess: "use", shares: [] });
    expect(toastError).toHaveBeenCalledWith("that person is not a member of this workspace");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});
