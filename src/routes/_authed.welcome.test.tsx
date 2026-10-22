import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

/**
 * The first run (A14, A29): the workspace, the first agent, its first
 * documents. The router is stood in for — `search` is what the URL asks for
 * and `navigate` what the screen asked it to become — and so is the API; the
 * query cache is real, so the optimistic writes are what the next render reads.
 */

const navigate = vi.fn();
let search: { step?: string; agent?: string; s?: string } = {};
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => ({
    ...options,
    useSearch: () => search,
  }),
  useNavigate: () => navigate,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const h = vi.hoisted(() => ({
  me: vi.fn(),
  onboardingGet: vi.fn(),
  update: vi.fn(),
  finish: vi.fn(),
  complete: vi.fn(),
  incoming: vi.fn(),
  events: vi.fn(),
  workspaceUpdate: vi.fn(),
  metadata: {} as Record<string, unknown>,
}));
vi.mock("@/lib/api-client", () => ({
  api: {
    me: h.me,
    onboarding: {
      get: h.onboardingGet,
      update: h.update,
      finish: h.finish,
      complete: h.complete,
      events: h.events,
    },
    invitations: { incoming: h.incoming },
    workspaces: { create: vi.fn() },
    workspace: { update: h.workspaceUpdate },
  },
  getAccessToken: () => Promise.resolve("tok"),
  ApiError: class ApiError extends Error {},
}));
vi.mock("@/lib/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { user: { user_metadata: h.metadata } } } }),
    },
  },
}));
vi.mock("@/lib/credits", () => ({ useIsHosted: () => true }));
vi.mock("@/lib/agents-store", () => ({
  useAgentsStore: () => ({
    agents: [{ id: "a9", name: "Support", avatar: "headset", bundleIds: [] }],
    createBundle: vi.fn(),
    attachBundle: vi.fn(),
    uploadToBundle: vi.fn(),
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/accept-invitation", () => ({
  OPEN_THE_EMAIL: "Open the email",
  useAcceptInvitation: () => ({ accept: vi.fn(), canAccept: () => true, busy: false }),
}));

import { meFixture } from "@/test/me-fixture";
import { EMPTY_ANSWERS } from "@/lib/onboarding-flow";
import type { OnboardingState } from "@/lib/api-client";

const EMPTY: OnboardingState = {
  completed: false,
  lastStep: null,
  agentId: null,
  sessionId: null,
  answers: EMPTY_ANSWERS,
};

function meWith(onboarding: OnboardingState) {
  return { ...meFixture(), onboarding };
}

async function renderWelcome() {
  const { Route } = await import("./_authed.welcome");
  const Component = (Route as unknown as { component: () => React.ReactElement }).component;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  search = {};
  h.metadata = {};
  sessionStorage.clear();
  h.me.mockResolvedValue(meWith(EMPTY));
  h.incoming.mockResolvedValue([]);
  h.update.mockResolvedValue(EMPTY);
  h.events.mockResolvedValue({ accepted: 1 });
  h.complete.mockResolvedValue({ completed: true });
  h.workspaceUpdate.mockResolvedValue({});
});

describe("the first run", () => {
  it("starts on naming the workspace, step 1 of 3, on the name given at sign-up", async () => {
    h.metadata = { workspace_name: "Acme Robotics" };
    await renderWelcome();

    expect(await screen.findByRole("heading", { name: "Name your workspace" })).toBeInTheDocument();
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Acme Robotics"));
  });

  it("moves on to the first agent once the workspace is named", async () => {
    await renderWelcome();
    const name = await screen.findByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Globex Robotics");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/welcome",
        search: { step: "assistant" },
        replace: true,
      }),
    );
    expect(h.workspaceUpdate).toHaveBeenCalledWith({ name: "Globex Robotics" });
  });

  it("makes the agent with its mark and jobs, then asks for its documents", async () => {
    search = { step: "assistant" };
    h.me.mockResolvedValue(meWith({ ...EMPTY, lastStep: "assistant" }));
    h.finish.mockResolvedValue({ completed: true, agentId: "a9", sessionId: "s9", created: true });
    await renderWelcome();

    expect(await screen.findByText("Step 2 of 3")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Name"), "Support");
    await userEvent.click(screen.getByRole("radio", { name: /owl/i }));
    await userEvent.click(screen.getByRole("button", { name: "Draft replies" }));
    await userEvent.click(screen.getByRole("button", { name: "Create Support" }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/welcome",
        search: { step: "first-docs", agent: "a9", s: "s9" },
        replace: true,
      }),
    );
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantName: "Support",
        assistantAvatar: "owl",
        assistantJobs: ["answer-questions", "draft-replies"],
      }),
    );
    expect(h.finish).toHaveBeenCalledWith({
      persona: expect.stringContaining("draft replies for the team to check and send"),
    });
  });

  it("starts the first agent on the Standard tier where the install serves it", async () => {
    search = { step: "assistant" };
    h.me.mockResolvedValue({
      ...meWith({ ...EMPTY, lastStep: "assistant" }),
      models: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"],
    });
    h.finish.mockResolvedValue({ completed: true, agentId: "a9", sessionId: "s9", created: true });
    await renderWelcome();

    expect(await screen.findByText("Step 2 of 3")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Name"), "Support");
    await userEvent.click(screen.getByRole("button", { name: "Create Support" }));

    await waitFor(() =>
      expect(h.finish).toHaveBeenCalledWith({
        persona: expect.any(String),
        model: "claude-sonnet-5",
      }),
    );
  });

  it("asks what the new agent should know, and opens it", async () => {
    search = { step: "first-docs", agent: "a9", s: "s9" };
    h.me.mockResolvedValue(meWith({ ...EMPTY, completed: true, agentId: "a9" }));
    await renderWelcome();

    expect(
      await screen.findByRole("heading", { name: "What should Support know?" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
    expect(screen.getByText(/earns the workspace 200 credits/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open Support" }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/agents/$agentId/chat",
      params: { agentId: "a9" },
      search: { s: "s9" },
      replace: true,
    });
  });

  it("sends a finished run without an agent in the address home", async () => {
    h.me.mockResolvedValue(meWith({ ...EMPTY, completed: true }));
    await renderWelcome();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/app", replace: true }));
  });

  it("saves and exits by finishing the run", async () => {
    await renderWelcome();
    await userEvent.click(await screen.findByRole("button", { name: "Save and exit" }));
    await waitFor(() => expect(h.complete).toHaveBeenCalled());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/app", replace: true }));
  });

  it("puts a waiting invitation first, outside the three steps", async () => {
    h.incoming.mockResolvedValue([
      {
        id: "inv-1",
        workspaceId: "w2",
        workspaceName: "Globex",
        inviterName: "Ada",
        role: "member",
      },
    ]);
    await renderWelcome();

    expect(await screen.findByRole("heading", { name: "You've been invited" })).toBeInTheDocument();
    expect(screen.queryByText(/Step \d of 3/)).not.toBeInTheDocument();
    expect(screen.getByText("Globex")).toBeInTheDocument();
  });
});
