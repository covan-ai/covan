import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

/**
 * The first run, from the first intro screen to the handoff into the chat.
 *
 * The router is stood in for: `search` is what the URL asks for, and
 * `navigate` is what the screen asked the URL to become. The API is stood in
 * for by module; the query cache is real, so the optimistic writes the screen
 * makes into it are what the next render reads, as in a browser.
 */

const navigate = vi.fn();
let search: { step?: string } = {};
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

const me = vi.fn();
const onboardingGet = vi.fn();
const update = vi.fn();
const finish = vi.fn();
const complete = vi.fn();
const incoming = vi.fn();
const events = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    me,
    onboarding: { get: onboardingGet, update, finish, complete, events },
    invitations: { incoming },
    feedback: { send: vi.fn() },
    workspaces: { create: vi.fn() },
    workspace: { update: vi.fn() },
  },
  getAccessToken: () => Promise.resolve("tok"),
  assetSrc: (path: string) => (path ? `https://api.test${path}` : ""),
  ApiError: class ApiError extends Error {},
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
const NAMED: OnboardingState = {
  ...EMPTY,
  answers: { ...EMPTY_ANSWERS, assistantName: "Desk", assistantEmoji: "🧭", assistantRole: "desk" },
};

function meWith(onboarding: typeof EMPTY) {
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
  sessionStorage.clear();
  localStorage.clear();
  me.mockResolvedValue(meWith(EMPTY));
  incoming.mockResolvedValue([]);
  update.mockResolvedValue(EMPTY);
  events.mockResolvedValue({ accepted: 1 });
  finish.mockResolvedValue({
    completed: true,
    agentId: "agent-9",
    sessionId: "session-9",
    created: true,
  });
  complete.mockResolvedValue({ completed: true });
});

describe("the intro", () => {
  it("opens on the first screen, with one phrase in the brand colour and a way past it", async () => {
    await renderWelcome();

    await screen.findByRole("heading", { name: /answers from your own documents/i });
    expect(screen.getByText("your own")).toHaveClass("text-brand");
    expect(screen.getByRole("button", { name: "Skip intro" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });

  it("moves on and records the screen it moved to", async () => {
    await renderWelcome();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: /answers from/i });

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(update).toHaveBeenCalledWith({ lastStep: "intro:apps" });
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/welcome", search: { step: "intro:apps" } }),
    );
  });

  it("skips to the first question", async () => {
    await renderWelcome();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: /answers from/i });

    await user.click(screen.getByRole("button", { name: "Skip intro" }));

    expect(update).toHaveBeenCalledWith({ lastStep: "assistant" });
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: { step: "assistant" } }),
    );
  });
});

describe("coming back", () => {
  it("resumes on the screen that was open", async () => {
    me.mockResolvedValue(meWith({ ...NAMED, lastStep: "purpose" }));
    await renderWelcome();

    await screen.findByRole("heading", { name: /what will it mostly do/i });
  });

  it("steps back to the last intro screen from the first question", async () => {
    me.mockResolvedValue(meWith({ ...EMPTY, lastStep: "assistant" }));
    await renderWelcome();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: /name your assistant/i });

    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(update).toHaveBeenCalledWith({ lastStep: "intro:team" });
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: { step: "intro:team" } }),
    );
  });
});

describe("the questions", () => {
  it("records the assistant's name and moves on", async () => {
    search = { step: "assistant" };
    await renderWelcome();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: /name your assistant/i });

    await user.click(screen.getByRole("radio", { name: /quill/i }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(update).toHaveBeenCalledWith({
      assistantName: "Quill",
      assistantEmoji: "✍️",
      assistantRole: "quill",
      lastStep: "tools",
    });
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ search: { step: "tools" } }));
  });

  it("will not continue past the tools without one, but will skip", async () => {
    me.mockResolvedValue(meWith({ ...NAMED, lastStep: "tools" }));
    await renderWelcome();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: /which tools/i });

    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Skip for now" }));

    expect(update).toHaveBeenCalledWith({ tools: [], lastStep: "purpose" });
  });

  it("asks about the team only when the team was chosen", async () => {
    me.mockResolvedValue(meWith({ ...NAMED, lastStep: "mode" }));
    await renderWelcome();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: /just you, or the team/i });

    await user.click(screen.getByRole("radio", { name: /my team/i }));
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(update).toHaveBeenCalledWith({ mode: "team", lastStep: "team" });
    expect(finish).not.toHaveBeenCalled();
  });
});

describe("the end", () => {
  it("makes the assistant once and opens its conversation", async () => {
    me.mockResolvedValue(meWith({ ...NAMED, lastStep: "mode" }));
    await renderWelcome();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: /just you, or the team/i });

    await user.click(screen.getByRole("radio", { name: /just me/i }));
    const button = screen.getByRole("button", { name: "Meet my assistant" });
    await user.click(button);
    await user.click(button);

    await waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
    expect(finish).toHaveBeenCalledWith({ persona: expect.stringContaining("tutor") });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "/agents/$agentId/chat",
          params: { agentId: "agent-9" },
          search: { s: "session-9" },
        }),
      ),
    );
    expect(sessionStorage.getItem("chat-kickoff:session-9")).toBe("1");
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("an invited account", () => {
  it("meets the invitation after the intro, and joining ends the run without an assistant", async () => {
    incoming.mockResolvedValue([
      { id: "inv-1", workspaceName: "Acme", inviterName: "Grace", role: "member" },
    ]);
    search = { step: "invite-accept" };
    await renderWelcome();

    await screen.findByRole("heading", { name: /you've been invited/i });
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
  });

  // 0115: no workspace yet. Its answers come from /onboarding rather than /me.
  it("starts a workspace for an account that has none", async () => {
    me.mockResolvedValue(null);
    onboardingGet.mockResolvedValue({ ...EMPTY, lastStep: "workspace" });
    await renderWelcome();

    await screen.findByRole("heading", { name: /start your workspace/i });
    expect(screen.getByLabelText("Workspace name")).toBeInTheDocument();
  });
});
