import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

/**
 * What arrives, after the welcome (0139): the report on its own page, a scan
 * started when there is none or the last one is old, and the mailbox and
 * calendar offered when nothing is connected to read.
 */
const navigate = vi.fn();
let search: { scan?: "1" } = {};
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

const h = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    me: vi.fn(),
    create: vi.fn(),
    latest: vi.fn(),
    start: vi.fn(),
    toolConnections: vi.fn(),
  };
});
vi.mock("@/lib/api-client", () => ({
  api: {
    me: h.me,
    arrivals: { latest: h.latest, start: h.start, get: vi.fn(), setRoutine: vi.fn() },
    toolConnections: { list: h.toolConnections },
    composio: { connect: vi.fn(), complete: vi.fn() },
    routines: { create: h.create },
    deliveryChannels: { list: vi.fn(async () => []) },
  },
  assetSrc: (path: string) => path,
  ApiError: h.ApiError,
}));
vi.mock("@/lib/agents-store", () => ({
  useAgentsStore: () => ({
    agents: [{ id: "a9", name: "Support", avatar: "headset", bundleIds: [] }],
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import userEvent from "@testing-library/user-event";
import { meFixture } from "@/test/me-fixture";

const NOW = Date.parse("2026-10-26T09:00:00Z");

function doneScan(daysAgo: number) {
  return {
    id: "scan-1",
    status: "done",
    total: 12,
    unanswered: 2,
    createdAt: new Date(NOW - daysAgo * 86_400_000).toISOString(),
    buckets: [
      {
        kind: "question",
        label: "",
        count: 5,
        unanswered: 2,
        examples: [],
        templateId: "arrivals-questions",
        routineId: null,
      },
    ],
  };
}

async function renderPage() {
  const { Route } = await import("./_authed.arrivals");
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
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  search = {};
  h.me.mockResolvedValue(meFixture());
  h.latest.mockResolvedValue(null);
  h.start.mockResolvedValue({ id: "scan-2", status: "queued", buckets: [] });
  h.toolConnections.mockResolvedValue({ connections: [], tools: [] });
});

describe("the arrivals page", () => {
  it("starts a scan when there has never been one", async () => {
    await renderPage();
    await waitFor(() => expect(h.start).toHaveBeenCalledTimes(1));
  });

  it("shows a recent scan without starting another", async () => {
    h.latest.mockResolvedValue(doneScan(2));
    await renderPage();
    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(h.start).not.toHaveBeenCalled();
  });

  it("scans again when the last one is over a week old", async () => {
    h.latest.mockResolvedValue(doneScan(8));
    await renderPage();
    await waitFor(() => expect(h.start).toHaveBeenCalledTimes(1));
  });

  it("scans again when asked to in the address", async () => {
    search = { scan: "1" };
    h.latest.mockResolvedValue(doneScan(1));
    await renderPage();
    await waitFor(() => expect(h.start).toHaveBeenCalledTimes(1));
  });

  // The agent the person's welcome made may be gone, or in another workspace;
  // the routines go to an agent of this workspace that is still here.
  it("makes the routines for an agent of this workspace, not a gone one", async () => {
    h.me.mockResolvedValue({
      ...meFixture(),
      onboarding: { completed: true, answers: {}, agentId: "gone-elsewhere" },
    });
    h.latest.mockResolvedValue(doneScan(2));
    h.create.mockResolvedValue({ id: "r-1", deliveryChannelId: "ch-1" });
    await renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Turn these on" }));
    await waitFor(() => expect(h.create).toHaveBeenCalled());
    expect(h.create.mock.calls[0][0].agentId).toBe("a9");
  });

  it("lands a skip on the use cases rather than the empty routines list", async () => {
    h.latest.mockResolvedValue(doneScan(2));
    await renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/routines/use-cases" });
  });

  it("offers the mailbox and calendar when nothing is connected to read", async () => {
    h.start.mockRejectedValue(new h.ApiError(409, "no_source"));
    await renderPage();
    expect(await screen.findByText("Gmail")).toBeInTheDocument();
    expect(screen.getByText("Google Calendar")).toBeInTheDocument();
  });
});
