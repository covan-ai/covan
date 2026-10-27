import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import type { Routine } from "@/lib/routines-api";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const queries: Record<string, unknown> = {};
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queries[queryKey[1] === "estimate" ? "estimate" : queryKey[0]],
  }),
}));

const setChannels = vi.fn();
const test = vi.fn();
const setGrant = vi.fn();
const patchRoutine = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    me: vi.fn(),
    routines: {
      estimate: vi.fn(),
      setChannels: (...a: unknown[]) => setChannels(...a),
      test: (...a: unknown[]) => test(...a),
      draft: vi.fn(),
      update: (...a: unknown[]) => patchRoutine(...a),
    },
    toolConnections: { setGrant: (...a: unknown[]) => setGrant(...a) },
  },
  assetSrc: (path: string) => path,
  ApiError: class ApiError extends Error {
    status = 400;
  },
}));
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) },
}));
vi.mock("@/lib/analytics", () => ({ trackStep: vi.fn(), flushEvents: vi.fn() }));

let channels: unknown[] = [];
const create = vi.fn();
const update = vi.fn();
vi.mock("@/hooks/use-routines", () => ({
  useDeliveryChannels: () => ({ data: channels }),
  useCreateRoutine: () => ({ mutateAsync: create, isPending: false }),
  useUpdateRoutine: () => ({ mutateAsync: update, isPending: false }),
  useEventCatalog: () => ({ data: [] }),
}));
let toolConnections: unknown[] = [];
const connectApp = vi.fn();
vi.mock("@/hooks/use-connections", () => ({
  useConnections: () => ({ data: { connections: [] } }),
  useToolConnections: () => ({ data: { connections: toolConnections, tools: [] } }),
  useConnectComposio: () => ({ mutate: connectApp, isPending: false }),
  useFinishPendingComposioGrant: () => undefined,
}));
vi.mock("@/lib/agents-store", () => ({
  useAgentsStore: () => ({
    agents: [
      {
        id: "a1",
        name: "Support",
        avatar: "headset",
        model: "gpt-4.1",
        bundleIds: ["b1"],
        myAccess: "edit",
        webSearch: false,
      },
    ],
    bundles: [{ id: "b1", name: "Policies" }],
  }),
}));

import { RoutineEditor } from "./routine-editor";

const email = (id: string, label: string) => ({
  id,
  kind: "email",
  label,
  createdAt: 0,
  confirmed: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  channels = [email("c1", "mina@acme.test"), email("c2", "can@acme.test")];
  toolConnections = [];
  sessionStorage.clear();
  queries.me = {
    members: [{ id: "u1", role: "member" }],
    user: { id: "u1", email: "mina@acme.test" },
    workspace: { timezone: "Europe/Istanbul" },
    models: ["gpt-4.1"],
    modelSpecs: {},
  };
  queries.estimate = {
    low: 15,
    high: 25,
    unit: "credits",
    runsPerMonth: 4,
    basedOn: { kind: "replies" },
  };
  create.mockResolvedValue({ id: "r-new" });
  update.mockResolvedValue({});
  setGrant.mockResolvedValue({});
  patchRoutine.mockResolvedValue({});
  setChannels.mockResolvedValue({ channelIds: [] });
});

describe("a new routine (A28)", () => {
  it("waits for a name and instructions, then saves what the fields say", async () => {
    const onSaved = vi.fn();
    render(<RoutineEditor initialAgentId="a1" cancelTo="/routines" onSaved={onSaved} />);
    const save = screen.getByRole("button", { name: "Save routine" });
    expect(save).toBeDisabled();

    await userEvent.click(screen.getByLabelText("Name"));
    await userEvent.paste("Weekly ticket themes");
    await userEvent.click(screen.getByLabelText("Instructions"));
    await userEvent.paste("Group last week's tickets.");
    await userEvent.click(save);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "a1",
        name: "Weekly ticket themes",
        sourceKind: "none",
        triggerKind: "schedule",
        instruction: "Group last week's tickets.",
        deliveryChannelId: "c1",
        scheduleCron: "0 9 * * 1",
        timezone: "Europe/Istanbul",
        outputBundleId: null,
        deliverInbox: true,
        model: null,
        reasoningEffort: null,
      }),
    );
    expect(setChannels).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith("r-new");
  });

  it("says what a run is likely to cost, and what that is based on", () => {
    render(<RoutineEditor initialAgentId="a1" cancelTo="/routines" onSaved={vi.fn()} />);
    expect(screen.getByText("About 15 to 25 credits per run · 4 runs a month")).toBeInTheDocument();
    expect(screen.getByText(/Based on what Support's replies cost\./)).toBeInTheDocument();
  });

  it("asks for an address when there is no channel yet, and takes your own by default", async () => {
    channels = [];
    render(<RoutineEditor initialAgentId="a1" cancelTo="/routines" onSaved={vi.fn()} />);
    await userEvent.click(screen.getByLabelText("Name"));
    await userEvent.paste("Digest");
    await userEvent.click(screen.getByLabelText("Instructions"));
    await userEvent.paste("Summarise.");
    await userEvent.click(screen.getByRole("button", { name: "Save routine" }));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryEmail: "mina@acme.test" }),
    );
  });

  it("starts from a template named in the link", () => {
    render(
      <RoutineEditor
        initialAgentId="a1"
        templateId="first-week"
        cancelTo="/routines"
        onSaved={vi.fn()}
      />,
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).not.toBe("");
  });

  // "Describe it in a sentence" on the use-cases page: the link's whole point
  // is this box, so the cursor starts there — and only when asked.
  it("puts the cursor in the sentence box when the link asks", () => {
    const { unmount } = render(
      <RoutineEditor initialAgentId="a1" focusSentence cancelTo="/routines" onSaved={vi.fn()} />,
    );
    expect(screen.getByLabelText("Start from a sentence")).toHaveFocus();
    unmount();
    render(<RoutineEditor initialAgentId="a1" cancelTo="/routines" onSaved={vi.fn()} />);
    expect(screen.getByLabelText("Start from a sentence")).not.toHaveFocus();
  });
});

const routine = {
  id: "r1",
  agentId: "a1",
  userId: "u1",
  name: "Daily digest",
  visibility: "private",
  sourceKind: "none",
  sourceUrl: null,
  connectionId: null,
  instruction: "Summarise.",
  deliveryChannelId: "c1",
  scheduleCron: "0 9 * * *",
  timezone: "Europe/Istanbul",
  triggerKind: "schedule",
  event: null,
  outputBundleId: null,
  outputRetention: 52,
  endsAfterRuns: null,
  runsDone: 0,
  browserAccess: "off",
  browserConversationId: null,
  status: "active",
  pausedReason: null,
  pausedBy: null,
  pausedAt: null,
  deliverInbox: true,
  model: null,
  reasoningEffort: null,
  channelIds: ["c2"],
  nextRunAt: null,
  lastRunAt: null,
  createdAt: 0,
} as unknown as Routine;

describe("an existing routine", () => {
  it("shows its agent and how it starts without offering to change them", () => {
    render(<RoutineEditor routine={routine} cancelTo="/routines/r1" onSaved={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "Agent" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Runs" })).toBeDisabled();
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("saves the change and the channels after the first", async () => {
    const onSaved = vi.fn();
    render(<RoutineEditor routine={routine} cancelTo="/routines/r1" onSaved={onSaved} />);
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.click(screen.getByLabelText("Name"));
    await userEvent.paste("Morning digest");
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save routine" }));

    expect(update).toHaveBeenCalledWith({
      id: "r1",
      patch: expect.objectContaining({
        name: "Morning digest",
        deliveryChannelId: "c1",
        scheduleCron: "0 9 * * *",
        deliverInbox: true,
      }),
    });
    expect(setChannels).toHaveBeenCalledWith("r1", ["c2"]);
    expect(onSaved).toHaveBeenCalledWith("r1");
  });

  it("runs a test of what is saved", async () => {
    test.mockResolvedValue({ status: "ok", itemsNew: 0, run: null });
    render(<RoutineEditor routine={routine} cancelTo="/routines/r1" onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Run a test" }));
    expect(test).toHaveBeenCalledWith("r1");
  });
});

/** What a use case needs before its first run (B3). */
describe("a routine started from a use case", () => {
  const gmail = (over: Record<string, unknown> = {}) => ({
    id: "conn-gmail",
    label: "Gmail",
    transport: "composio",
    toolkitSlug: "gmail",
    status: "active",
    scope: "owner",
    mine: true,
    ...over,
  });

  it("shows what it needs, with Connect for an app that is missing", () => {
    render(
      <RoutineEditor
        initialAgentId="a1"
        templateId="reply-drafts"
        cancelTo="/routines"
        onSaved={() => {}}
      />,
    );
    expect(screen.getByText("Needs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Gmail" })).toBeInTheDocument();
  });

  it("parks the form before connecting, and comes back to this page", async () => {
    render(
      <RoutineEditor
        initialAgentId="a1"
        templateId="reply-drafts"
        cancelTo="/routines"
        onSaved={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    expect(connectApp).toHaveBeenCalledWith(
      { toolkit: "gmail", returnTo: "/routines/new?template=reply-drafts&agent=a1" },
      expect.anything(),
    );
    const parked = JSON.parse(sessionStorage.getItem("covan.routine-draft") ?? "{}");
    expect(parked).toMatchObject({ path: "/routines/new", templateId: "reply-drafts" });
    expect(parked.draft.agentId).toBe("a1");
  });

  it("reads a parked form back once, with a switch the person turned off", () => {
    toolConnections = [gmail()];
    sessionStorage.setItem(
      "covan.routine-draft",
      JSON.stringify({
        path: "/routines/new",
        templateId: "reply-drafts",
        at: Date.now(),
        draft: {
          agentId: "a1",
          name: "My drafts",
          runs: "schedule",
          connectionId: "",
          cron: "0 7 * * 1-5",
          timezone: "UTC",
          instruction:
            "Draft replies only. Never send, reply, delete or change anything else there.",
          fileTo: null,
          emailIds: null,
          inbox: true,
          model: null,
          effort: null,
          allowOff: ["conn-gmail"],
          browserOn: true,
        },
      }),
    );
    render(
      <RoutineEditor
        initialAgentId="a1"
        templateId="reply-drafts"
        cancelTo="/routines"
        onSaved={() => {}}
      />,
    );
    expect(screen.getByLabelText("Name")).toHaveValue("My drafts");
    expect(
      screen.getByRole("switch", { name: "Let Support change things in Gmail without asking" }),
    ).not.toBeChecked();
    expect(sessionStorage.getItem("covan.routine-draft")).toBeNull();
  });

  it("creates the routine, then lets the agent change things in the app", async () => {
    toolConnections = [gmail()];
    const onSaved = vi.fn();
    render(
      <RoutineEditor
        initialAgentId="a1"
        templateId="reply-drafts"
        cancelTo="/routines"
        onSaved={onSaved}
      />,
    );
    expect(screen.getByText("Connected")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save routine" }));
    expect(create).toHaveBeenCalled();
    expect(setGrant).toHaveBeenCalledWith({ agentId: "a1", connectionId: "conn-gmail" });
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(setGrant.mock.invocationCallOrder[0]);
    expect(onSaved).toHaveBeenCalledWith("r-new");
  });

  it("keeps the routine when the permission fails, and names the app", async () => {
    toolConnections = [gmail()];
    setGrant.mockRejectedValue(new Error("denied"));
    const onSaved = vi.fn();
    render(
      <RoutineEditor
        initialAgentId="a1"
        templateId="reply-drafts"
        cancelTo="/routines"
        onSaved={onSaved}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save routine" }));
    expect(onSaved).toHaveBeenCalledWith("r-new");
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Gmail"));
  });

  it("offers no switch on somebody else's app, and says who can allow it", () => {
    toolConnections = [gmail({ mine: false, scope: "workspace" })];
    render(
      <RoutineEditor
        initialAgentId="a1"
        templateId="reply-drafts"
        cancelTo="/routines"
        onSaved={() => {}}
      />,
    );
    expect(screen.queryByRole("switch", { name: /without asking/ })).not.toBeInTheDocument();
    expect(
      screen.getByText("Only the person who connected Gmail, or an admin, can allow this."),
    ).toBeInTheDocument();
  });

  it("turns the browser on after creating, for a use case that needs it", async () => {
    render(
      <RoutineEditor
        initialAgentId="a1"
        templateId="competitor-watch"
        cancelTo="/routines"
        onSaved={() => {}}
      />,
    );
    expect(screen.getByRole("switch", { name: "Let it use a browser" })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Save routine" }));
    expect(patchRoutine).toHaveBeenCalledWith("r-new", { browserAccess: "all" });
  });

  it("chooses the calendar event a booking card waits for", () => {
    render(
      <RoutineEditor
        initialAgentId="a1"
        templateId="new-booking"
        cancelTo="/routines"
        onSaved={() => {}}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Runs" })).toHaveTextContent(
      "When an app event happens",
    );
  });
});
