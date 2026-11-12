import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

/**
 * A request an agent made while nobody was watching (0143), on its own page:
 * what it wants, the two buttons for whoever may answer, and what happens
 * after an answer — the cron carries on, so the page says so.
 */
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => ({
    ...options,
    useParams: () => ({ approvalId: "pause-1" }),
  }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const h = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { ApiError, get: vi.fn(), answer: vi.fn() };
});
vi.mock("@/lib/api-client", () => ({
  api: { approvals: { get: h.get, answer: h.answer } },
  ApiError: h.ApiError,
}));

const REQUEST = {
  id: "pause-1",
  origin: "routine",
  tool: "http_request",
  summary: "POST to Box office?",
  proposal: { method: "POST", path: "/seats/14/close" },
  status: "pending",
  expiresAt: Date.now() + 86_400_000,
  createdAt: Date.now(),
  resolvedAt: null,
  resolvedVia: null,
  resumedAt: null,
  mine: true,
  canAnswer: true,
  sessionId: "conv-1",
  agent: { id: "agent-1", name: "Box office agent" },
  routine: { id: "routine-1", name: "Seat requests" },
  owner: { id: "owner-1", name: "Ada" },
  resolvedBy: null,
};

async function renderPage() {
  const { Route } = await import("./_authed.approvals.$approvalId");
  const Component = (Route as unknown as { component: () => React.ReactElement }).component;
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Component />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a request nobody was watching", () => {
  it("shows what the agent wants to do, for which routine, with the two buttons", async () => {
    h.get.mockResolvedValue({ approval: REQUEST });
    await renderPage();

    expect(await screen.findByText("POST to Box office?")).toBeInTheDocument();
    expect(
      screen.getByText("Box office agent is asking, running “Seat requests”"),
    ).toBeInTheDocument();
    expect(screen.getByText("/seats/14/close")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the conversation" })).toBeInTheDocument();
  });

  it("answers, and says the agent carries on rather than claiming it is done", async () => {
    h.get.mockResolvedValueOnce({ approval: REQUEST });
    h.answer.mockResolvedValue({ status: "approved" });
    h.get.mockResolvedValue({
      approval: { ...REQUEST, status: "approved", canAnswer: false },
    });
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));

    expect(h.answer).toHaveBeenCalledWith("pause-1", true);
    expect(
      await screen.findByText("Approved. The agent carries on within a few minutes."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("says who answered, which may be an admin rather than the owner", async () => {
    h.get.mockResolvedValue({
      approval: {
        ...REQUEST,
        status: "approved",
        canAnswer: false,
        resumedAt: Date.now(),
        resolvedBy: { id: "admin-1", name: "Grace" },
      },
    });
    await renderPage();
    expect(await screen.findByText("Grace answered")).toBeInTheDocument();
    expect(screen.getByText("Approved, and the agent carried on.")).toBeInTheDocument();
  });

  it("offers no buttons to somebody who may only read it", async () => {
    h.get.mockResolvedValue({
      approval: { ...REQUEST, mine: false, canAnswer: false, sessionId: null },
    });
    await renderPage();

    await screen.findByText("POST to Box office?");
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open the conversation" })).not.toBeInTheDocument();
  });

  it("says when somebody else got there first", async () => {
    h.get.mockResolvedValue({ approval: REQUEST });
    h.answer.mockRejectedValue(new h.ApiError(409, "this was already answered"));
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));

    await waitFor(() => {
      expect(
        screen.getByText("Somebody answered this first, or it ran out of time."),
      ).toBeInTheDocument();
    });
  });

  it("says there is nothing here for what the caller may not see", async () => {
    h.get.mockRejectedValue(new h.ApiError(404, "no such request"));
    await renderPage();
    expect(
      await screen.findByText("There is nothing here, or it isn't yours to see."),
    ).toBeInTheDocument();
  });
});
