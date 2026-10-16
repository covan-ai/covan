import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RoutineEventCard } from "./routine-event-card";
import type { Routine, RoutineEvent } from "@/lib/routines-api";

const { eventCatalog, setEvent, removeEvent, testEvent, eventSetup, toast } = vi.hoisted(() => ({
  eventCatalog: vi.fn(),
  setEvent: vi.fn(),
  removeEvent: vi.fn(),
  testEvent: vi.fn(),
  eventSetup: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@/lib/api-client", () => ({
  api: { routines: { eventCatalog, setEvent, removeEvent, testEvent, eventSetup } },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const EVENT: RoutineEvent = {
  type: "gmail.new_message",
  provider: "composio",
  app: "Gmail",
  label: "New mail",
  config: {},
  status: "active",
  statusDetail: null,
  lastEventAt: null,
  expiresAt: null,
};

const routine = (event: RoutineEvent | null): Routine => ({
  id: "r1",
  agentId: "a1",
  userId: "u1",
  name: "Inbox",
  visibility: "private",
  sourceKind: "none",
  sourceUrl: null,
  connectionId: null,
  instruction: "tell me what matters",
  deliveryChannelId: "c1",
  scheduleCron: "0 9 * * *",
  timezone: "UTC",
  triggerKind: "event",
  event,
  outputBundleId: null,
  outputRetention: 52,
  endsAfterRuns: null,
  runsDone: 0,
  browserAccess: "off",
  browserSite: null,
  browserConversationId: null,
  status: "active",
  pausedReason: null,
  nextRunAt: null,
  lastRunAt: null,
  createdAt: 0,
});

function renderCard(event: RoutineEvent | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RoutineEventCard routine={routine(event)} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of [eventCatalog, setEvent, removeEvent, testEvent, eventSetup]) fn.mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
  eventCatalog.mockResolvedValue([
    {
      type: "gmail.new_message",
      provider: "composio",
      app: "Gmail",
      label: "New mail",
      description: "A message arrives in the inbox.",
      fields: [],
      requires: { kind: "composio", toolkit: "gmail" },
      connected: true,
    },
  ]);
});

describe("RoutineEventCard", () => {
  it("says what it listens for, and that it is listening", () => {
    renderCard(EVENT);
    expect(screen.getByText("Gmail · New mail")).toBeInTheDocument();
    expect(screen.getByText("Listening")).toBeInTheDocument();
    expect(screen.getByText("Nothing has arrived yet.")).toBeInTheDocument();
  });

  // The sentence is what the owner acts on; the chip is only the headline.
  it("shows why it is not listening, and offers to reconnect", () => {
    renderCard({ ...EVENT, status: "expired", statusDetail: "Gmail is no longer connected." });
    expect(screen.getByText("Needs reconnecting")).toBeInTheDocument();
    expect(screen.getByText("Gmail is no longer connected.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("sends a test event and says where the result went", async () => {
    testEvent.mockResolvedValue({ status: "ok", itemsNew: 1 });
    const user = userEvent.setup();
    renderCard(EVENT);

    await user.click(screen.getByRole("button", { name: /send a test event/i }));

    expect(testEvent).toHaveBeenCalledWith("r1");
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/run history/));
  });

  it("shows a GitHub routine the webhook to add, with the secret behind a button", async () => {
    eventSetup.mockResolvedValue({
      kind: "github",
      url: "https://api.example.com/routine-events/github/gh_abc",
      secret: "s3cret",
      contentType: "application/json",
    });
    const user = userEvent.setup();
    renderCard({ ...EVENT, type: "github.push", provider: "github", app: "GitHub", label: "Push" });

    expect(
      await screen.findByText("https://api.example.com/routine-events/github/gh_abc"),
    ).toBeInTheDocument();
    expect(screen.getByText(/tick Pushes/)).toBeInTheDocument();
    expect(screen.queryByText("s3cret")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show secret" }));
    expect(screen.getByText("s3cret")).toBeInTheDocument();
    expect(eventSetup).toHaveBeenCalledWith("r1");
  });

  it("asks for nothing to be pasted for an event Covan sets up itself", () => {
    renderCard(EVENT);
    expect(eventSetup).not.toHaveBeenCalled();
  });

  it("asks for an event straight away when none was chosen", async () => {
    setEvent.mockResolvedValue(routine(EVENT));
    const user = userEvent.setup();
    renderCard(null);

    await user.click(await screen.findByLabelText(/^app$/i));
    await user.click(await screen.findByRole("option", { name: "Gmail" }));
    await user.click(screen.getByRole("button", { name: /start listening/i }));

    expect(setEvent).toHaveBeenCalledWith("r1", { type: "gmail.new_message", config: {} });
    expect(toast.success).toHaveBeenCalledWith("Listening to Gmail");
  });
});
