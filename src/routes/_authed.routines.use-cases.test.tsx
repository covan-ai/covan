import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

/**
 * The use cases (spec 2026-10-27-use-cases-design.md, "The page"): every card
 * by area of work, the inbox scan offered first, and picking a card costing
 * nothing but a step to the editor or to "New agent".
 */
const navigate = vi.fn();
let search: { agent?: string } = {};
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => ({
    ...options,
    useSearch: () => search,
  }),
  useNavigate: () => navigate,
  Link: ({
    children,
    to,
    search,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    search?: Record<string, string | undefined>;
    className?: string;
  }) => {
    const query = new URLSearchParams(
      Object.entries(search ?? {}).filter((e): e is [string, string] => e[1] !== undefined),
    ).toString();
    return (
      <a href={query ? `${to}?${query}` : to} className={className}>
        {children}
      </a>
    );
  },
}));

const h = vi.hoisted(() => ({
  me: vi.fn(),
  latest: vi.fn(),
  toolConnections: vi.fn(),
  connections: vi.fn(),
  openCreateAgent: vi.fn(),
  trackStep: vi.fn(),
  flushEvents: vi.fn(async () => {}),
  store: { canWrite: true, agents: [] as Array<Record<string, unknown>> },
}));
vi.mock("@/lib/api-client", () => ({
  api: {
    me: h.me,
    arrivals: { latest: h.latest },
    toolConnections: { list: h.toolConnections },
    connections: { list: h.connections },
  },
  assetSrc: (path: string) => path,
}));
vi.mock("@/lib/agents-store", () => ({ useAgentsStore: () => h.store }));
vi.mock("@/lib/shell", () => ({ useShell: () => ({ openCreateAgent: h.openCreateAgent }) }));
vi.mock("@/lib/analytics", () => ({ trackStep: h.trackStep, flushEvents: h.flushEvents }));

import { meFixture } from "@/test/me-fixture";

const SUPPORT = {
  id: "a9",
  name: "Support",
  avatar: "headset",
  webSearch: true,
  documents: [{ id: "d1" }],
};
const RESEARCH = { id: "a3", name: "Research", avatar: "owl", webSearch: false, documents: [] };

async function renderPage() {
  const { Route } = await import("./_authed.routines.use-cases");
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
  search = {};
  h.store = { canWrite: true, agents: [SUPPORT, RESEARCH] };
  h.me.mockResolvedValue(meFixture({ role: "member" }));
  h.latest.mockResolvedValue(null);
  h.toolConnections.mockResolvedValue({
    connections: [
      { transport: "composio", status: "active", toolkitSlug: "gmail" },
      { transport: "composio", status: "pending", toolkitSlug: "googlecalendar" },
    ],
    tools: [],
  });
  h.connections.mockResolvedValue({ connections: [], providers: [] });
});

describe("the use-cases page", () => {
  it("lays the cards out under the five areas of work", async () => {
    await renderPage();
    for (const name of [
      "Inbox and calendar",
      "Team and knowledge",
      "Customers and sales",
      "Operations and admin",
      "Research and insight",
    ]) {
      expect(await screen.findByRole("region", { name })).toBeInTheDocument();
    }
    const inbox = screen.getByRole("region", { name: "Inbox and calendar" });
    expect(within(inbox).getByRole("button", { name: "Daily brief" })).toBeInTheDocument();
  });

  it("reads what is connected: an active app counts, a pending one does not", async () => {
    await renderPage();
    const brief = await screen.findByRole("button", { name: "Daily brief" });
    expect(within(brief).getByText("Google Calendar or Outlook not connected")).toBeInTheDocument();
    expect(within(brief).queryByText("Gmail or Outlook not connected")).not.toBeInTheDocument();
  });

  it("gives a blocked card its reason and no button", async () => {
    await renderPage();
    await screen.findByRole("button", { name: "Daily brief" });
    expect(screen.queryByRole("button", { name: "What nobody wrote down" })).toBeNull();
    expect(screen.getByText(/^Only an admin of this workspace/)).toBeInTheDocument();
  });

  it("shows a viewer the same cards with nothing to press", async () => {
    h.store = { canWrite: false, agents: [SUPPORT] };
    await renderPage();
    expect(await screen.findByText("Daily brief")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryAllByRole("link")).toEqual([]);
    expect(screen.queryByText("Look at your inbox first")).not.toBeInTheDocument();
  });

  it("offers a scan when there has been none", async () => {
    await renderPage();
    const link = await screen.findByRole("link", { name: "Scan my inbox" });
    expect(link).toHaveAttribute("href", "/arrivals");
    expect(screen.queryByText(/^Scanned /)).not.toBeInTheDocument();
  });

  it("offers what arrived once a scan exists, and says when it ran", async () => {
    h.latest.mockResolvedValue({
      id: "scan-1",
      status: "done",
      createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
    await renderPage();
    const link = await screen.findByRole("link", { name: "See what arrived" });
    expect(link).toHaveAttribute("href", "/arrivals");
    expect(screen.getByText("Scanned 2 days ago")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Scan my inbox" })).toBeNull();
  });

  it("opens the editor on a routine card's template, for the agent, and counts the pick", async () => {
    await renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Daily brief" }));
    expect(h.trackStep).toHaveBeenCalledWith("use-case:daily-brief", "viewed");
    expect(h.flushEvents).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({
      to: "/routines/new",
      search: { template: "daily-brief", agent: "a9" },
    });
  });

  it("uses the agent the address names", async () => {
    search = { agent: "a3" };
    await renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Daily brief" }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/routines/new",
      search: { template: "daily-brief", agent: "a3" },
    });
    // Research has web search off, which a card that searches says.
    const news = screen.getByRole("button", { name: "News that matters to us" });
    expect(within(news).getByText("Needs web search on Research")).toBeInTheDocument();
  });

  it("opens New agent filled in from an agent card", async () => {
    await renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "A researcher" }));
    expect(h.trackStep).toHaveBeenCalledWith("use-case:researcher", "viewed");
    expect(h.openCreateAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Research",
        avatar: "penguin",
        webSearch: true,
        trackAs: "use-case:researcher",
        persona: expect.stringMatching(/^You research questions on the web/),
      }),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("ends on a sentence of one's own, and leads with setting it up by hand", async () => {
    await renderPage();
    expect(await screen.findByRole("link", { name: "Describe it in a sentence" })).toHaveAttribute(
      "href",
      "/routines/new?focus=sentence&agent=a9",
    );
    expect(screen.getByRole("link", { name: "Set it up myself" })).toHaveAttribute(
      "href",
      "/routines/new?agent=a9",
    );
  });
});
