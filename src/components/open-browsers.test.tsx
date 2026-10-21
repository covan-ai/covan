import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OpenBrowsers, OpenConversationBrowser, OpenTakeover } from "@/lib/api-client";
import { OpenBrowsersList } from "./open-browsers";

/**
 * The person's open browsers on Settings → Browser sign-ins (Task 3.2, ruling
 * R48): where each one is, who has it, when it was last used, and a way to end
 * it — except the one the agent is using, which a stop would not end cleanly
 * (R17) and which says so and points at its conversation instead.
 *
 * The list never mints a live URL and never asks for one: it draws named
 * fields only, so a field that should never be here is not drawn even if a
 * response ever carried one.
 */

const open = vi.fn();
const stop = vi.fn();
const close = vi.fn();
const live = vi.fn();
const current = vi.fn();

vi.mock("@/lib/api-client", () => ({
  api: {
    browser: {
      open: (...a: unknown[]) => open(...a),
      stop: (...a: unknown[]) => stop(...a),
      live: (...a: unknown[]) => live(...a),
    },
    takeovers: {
      close: (...a: unknown[]) => close(...a),
      current: (...a: unknown[]) => current(...a),
    },
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    search,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    params: { agentId: string };
    search: { s: string };
    className?: string;
  }) => (
    <a href={`${to.replace("$agentId", params.agentId)}?s=${search.s}`} className={className}>
      {children}
    </a>
  ),
}));

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const AGENTS: OpenConversationBrowser = {
  id: "bs-agent",
  conversation: { id: "chat-1", title: "Supplier pricing" },
  agent: { id: "agent-1", name: "Researcher" },
  liveState: "agent",
  running: true,
  stoppable: false,
  browserOpen: true,
  lastUsedAt: minutesAgo(1),
};
const MINE: OpenConversationBrowser = {
  id: "bs-human",
  conversation: { id: "chat-2", title: "Book the venue" },
  agent: { id: "agent-1", name: "Researcher" },
  liveState: "human",
  running: false,
  stoppable: true,
  browserOpen: true,
  lastUsedAt: minutesAgo(2),
};
const IDLE: OpenConversationBrowser = {
  id: "bs-idle",
  conversation: { id: "chat-3", title: "Compare plans" },
  agent: { id: "agent-2", name: "Scout" },
  liveState: "none",
  running: false,
  stoppable: true,
  browserOpen: true,
  lastUsedAt: minutesAgo(4),
};
/** The agent had it last and no run is going: a finished run the cron has not settled yet. */
const AGENT_LEFT: OpenConversationBrowser = {
  id: "bs-left",
  conversation: { id: "chat-6", title: "Track the parcel" },
  agent: { id: "agent-1", name: "Researcher" },
  liveState: "agent",
  running: false,
  stoppable: false,
  browserOpen: true,
  lastUsedAt: minutesAgo(3),
};
const OUT_OF_SIGHT: OpenConversationBrowser = {
  ...IDLE,
  id: "bs-gone",
  conversation: null,
};
const OWN_TAKEOVER: OpenTakeover = {
  id: "to-1",
  forTask: false,
  conversation: null,
  agent: null,
  openedAt: minutesAgo(3),
  expiresAt: new Date(Date.now() + 7 * 60_000).toISOString(),
};

function renderList(props: Parameters<typeof OpenBrowsersList>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const view = render(
    <QueryClientProvider client={client}>
      <OpenBrowsersList {...props} />
    </QueryClientProvider>,
  );
  return { ...view, invalidate };
}

const rowOf = async (text: string) => (await screen.findByText(text)).closest("li")!;

beforeEach(() => {
  open.mockReset().mockResolvedValue({
    browsers: [AGENTS, MINE, IDLE],
    takeover: null,
  } satisfies OpenBrowsers);
  stop.mockReset().mockResolvedValue(undefined);
  close.mockReset().mockResolvedValue({
    retriedTaskId: null,
    cookieDomains: ["portal.example.com"],
    message: "your sign-in is saved",
  });
  live.mockReset();
  current.mockReset();
});

describe("OpenBrowsersList", () => {
  it("names where each browser is, who has it, and when it was last used", async () => {
    renderList();

    const agents = await rowOf("Supplier pricing");
    expect(within(agents).getByText("Researcher")).toBeInTheDocument();
    expect(within(agents).getByText("The agent is using it")).toBeInTheDocument();
    expect(within(agents).getByText(/^Last used /)).toBeInTheDocument();

    const mine = await rowOf("Book the venue");
    expect(within(mine).getByText("You are using it")).toBeInTheDocument();

    // True to the sweep: ten minutes after the last run, an idle browser is stopped.
    const idle = await rowOf("Compare plans");
    expect(
      within(idle).getByText(/^Idle — it stops by itself about ten minutes/),
    ).toBeInTheDocument();
  });

  it("calls an untitled conversation what the sidebar calls it", async () => {
    open.mockResolvedValue({
      browsers: [{ ...IDLE, conversation: { id: "chat-9", title: null } }],
      takeover: null,
    });
    renderList();

    expect(await rowOf("New thread")).toBeInTheDocument();
  });

  it("says something neutral for a conversation the person can no longer open", async () => {
    open.mockResolvedValue({ browsers: [OUT_OF_SIGHT], takeover: null });
    renderList();

    const row = await rowOf("A conversation you can no longer open");
    expect(within(row).queryByRole("link")).toBeNull();
    expect(within(row).getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  /** R17: a stop does not cancel a run, and a run whose browser vanished settles as a failure. */
  it("offers no Stop on the browser the agent is using, and links to its conversation", async () => {
    renderList();

    const agents = await rowOf("Supplier pricing");
    expect(within(agents).queryByRole("button", { name: "Stop" })).toBeNull();
    expect(within(agents).getByRole("link", { name: "Open the conversation" })).toHaveAttribute(
      "href",
      "/agents/agent-1/chat?s=chat-1",
    );
  });

  /**
   * Ruling R51 (c): the agent had it last and nothing is running. Not "nobody
   * is using it" — the stop route refuses such a row for ten minutes after its
   * last run — so the row says how to end it, and offers Stop only once the
   * server would take it.
   */
  it("says the agent had it last and points at its conversation, with no Stop the server would refuse", async () => {
    open.mockResolvedValue({ browsers: [AGENT_LEFT], takeover: null });
    renderList();

    const row = await rowOf("Track the parcel");
    expect(
      within(row).getByText("The agent had it last — take it over in the conversation to close it"),
    ).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Stop" })).toBeNull();
    expect(within(row).getByRole("link", { name: "Open the conversation" })).toHaveAttribute(
      "href",
      "/agents/agent-1/chat?s=chat-6",
    );
  });

  it("offers Stop on such a row once the server would accept it, even with its conversation gone", async () => {
    open.mockResolvedValue({
      browsers: [
        { ...AGENT_LEFT, conversation: null, stoppable: true, lastUsedAt: minutesAgo(12) },
      ],
      takeover: null,
    });
    renderList();

    const row = await rowOf("A conversation you can no longer open");
    expect(
      within(row).getByText("The agent had it last and is not using it now"),
    ).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "Stop" }));
    await userEvent.click(await screen.findByRole("button", { name: "Stop it" }));
    expect(stop).toHaveBeenCalledWith("bs-left");
  });

  it("stops a browser after a confirmation, and refreshes the list and the sign-ins", async () => {
    const { invalidate } = renderList();

    const mine = await rowOf("Book the venue");
    await userEvent.click(within(mine).getByRole("button", { name: "Stop" }));
    expect(stop).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole("button", { name: "Stop it" }));

    expect(stop).toHaveBeenCalledWith("bs-human");
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["browser-profile"]));
    expect(keys).toContain(JSON.stringify(["browser-open"]));
  });

  it("shows the server's refusal in the dialog", async () => {
    const { ApiError } = await import("@/lib/api-error");
    stop.mockRejectedValue(
      new ApiError(
        502,
        "the browser could not be stopped just now. Try closing it again in a moment.",
      ),
    );
    renderList();

    const idle = await rowOf("Compare plans");
    await userEvent.click(within(idle).getByRole("button", { name: "Stop" }));
    await userEvent.click(await screen.findByRole("button", { name: "Stop it" }));

    expect(
      await screen.findByText(
        "the browser could not be stopped just now. Try closing it again in a moment.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  /**
   * Ruling R50: Stop never kills a running agent run. A run that started after
   * the list was read is refused by the server, and its sentence is what the
   * dialog shows — the dialog stays open, and nothing claims it stopped.
   */
  it("shows the server's 409 when the agent has started using the browser since", async () => {
    const { ApiError } = await import("@/lib/api-error");
    const SENTENCE =
      "The agent is using this browser right now. Take it over in the conversation first.";
    stop.mockRejectedValue(new ApiError(409, SENTENCE));
    renderList();

    const idle = await rowOf("Compare plans");
    await userEvent.click(within(idle).getByRole("button", { name: "Stop" }));
    await userEvent.click(await screen.findByRole("button", { name: "Stop it" }));

    expect(stop).toHaveBeenCalledWith("bs-idle");
    expect(await screen.findByText(SENTENCE)).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("names the person's own browser and closes it, refreshing the list and the sign-ins", async () => {
    open.mockResolvedValue({ browsers: [], takeover: OWN_TAKEOVER });
    const { invalidate } = renderList();

    const own = await rowOf("Your own browser");
    expect(within(own).getByText(/^Closes by itself at /)).toBeInTheDocument();
    await userEvent.click(within(own).getByRole("button", { name: "Close" }));
    await userEvent.click(await screen.findByRole("button", { name: "Close it" }));

    expect(close).toHaveBeenCalledWith("to-1");
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["browser-profile"]));
  });

  /** Ruling R49: past its window it is still open, and the sweep's stop saves it too. */
  it("says a browser whose time is up closes by itself and keeps the sign-ins", async () => {
    open.mockResolvedValue({
      browsers: [],
      takeover: { ...OWN_TAKEOVER, expiresAt: minutesAgo(1) },
    });
    renderList();

    const own = await rowOf("Your own browser");
    expect(
      within(own).getByText(
        "Time is up. Close it to finish; if you don't, it closes by itself shortly and your sign-ins are still saved.",
      ),
    ).toBeInTheDocument();
    expect(within(own).getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("says a task's browser runs its task again when closed", async () => {
    open.mockResolvedValue({
      browsers: [],
      takeover: {
        ...OWN_TAKEOVER,
        forTask: true,
        conversation: { id: "chat-9", title: "The portal" },
        agent: { id: "agent-2", name: "Scout" },
      },
    });
    renderList();

    const row = await rowOf("The portal");
    await userEvent.click(within(row).getByRole("button", { name: "Close" }));
    expect((await screen.findByRole("alertdialog")).textContent).toContain("runs again");
  });

  it("never draws a live URL, and never asks for one", async () => {
    open.mockResolvedValue({
      browsers: [{ ...MINE, liveUrl: "https://live.browser-use.example/v/secret" }],
      takeover: { ...OWN_TAKEOVER, liveUrl: "https://live.browser-use.example/v/other" },
    });
    const { container } = renderList();

    await screen.findByText("Book the venue");
    expect(container.innerHTML).not.toContain("live.browser-use");
    expect(live).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
  });

  it("renders nothing when no browser is open", async () => {
    open.mockResolvedValue({ browsers: [], takeover: null });
    const { container } = renderList();

    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
