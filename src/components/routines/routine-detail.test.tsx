import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { RoutineDetail } from "./routine-detail";
import type { Routine, RoutineRun } from "@/lib/routines-api";

// The webhook card this screen renders for a poke-able routine reaches the API,
// and `lib/api-client` builds its Supabase client at module load — which throws
// under vitest, where the VITE_ vars are unset. Every other component test that
// touches the API mocks it for the same reason.
//
// The routine below is `schedule`, so the card is not rendered at all; this is
// about the import graph rather than about the card.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
// Its own test is routine-changes-card.test.tsx; here it would need the
// connection hooks and a query client for a card this file is not about.
vi.mock("./routine-changes-card", () => ({ RoutineChangesCard: () => null }));
vi.mock("@/lib/api-client", () => ({
  api: { routines: { trigger: vi.fn(), createTrigger: vi.fn(), removeTrigger: vi.fn() } },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const routine: Routine = {
  id: "r1",
  agentId: "a1",
  userId: "me",
  name: "r/SaaS new posts",
  visibility: "private",
  sourceKind: "rss",
  sourceUrl: "https://example.com/feed.xml",
  connectionId: null,
  instruction: "summarise new posts",
  deliveryChannelId: "c1",
  scheduleCron: "0 * * * *",
  timezone: "Europe/Istanbul",
  triggerKind: "schedule" as const,
  event: null,
  outputBundleId: null,
  outputRetention: 52,
  endsAfterRuns: null,
  runsDone: 0,
  browserAccess: "off" as const,
  browserSite: null,
  browserConversationId: null,
  status: "active",
  pausedReason: null,
  pausedBy: null,
  pausedAt: null,
  deliverInbox: true,
  model: null,
  reasoningEffort: null,
  channelIds: [],
  nextRunAt: null,
  lastRunAt: null,
  createdAt: 0,
};

const runs: RoutineRun[] = [
  {
    id: "1",
    status: "ok",
    itemsNew: 3,
    itemsOverflow: 0,
    nothingRelevant: false,
    durationMs: 1400,
    error: null,
    summary: "Three new posts about pricing.",
    documentId: null,
    filingNote: null,
    outcome: null,
    model: null,
    triggeredBy: null,
    triggerLabel: null,
    sessionId: null,
    deliveryNote: null,
    startedAt: 0,
  },
  {
    id: "2",
    status: "skipped",
    itemsNew: 0,
    itemsOverflow: 0,
    nothingRelevant: false,
    durationMs: 300,
    error: null,
    summary: null,
    documentId: null,
    filingNote: null,
    outcome: null,
    model: null,
    triggeredBy: null,
    triggerLabel: null,
    sessionId: null,
    deliveryNote: null,
    startedAt: 0,
  },
  {
    id: "3",
    status: "failed",
    itemsNew: 0,
    itemsOverflow: 0,
    nothingRelevant: false,
    durationMs: 2100,
    error: "upstream 503",
    summary: null,
    documentId: null,
    filingNote: null,
    outcome: null,
    model: null,
    triggeredBy: null,
    triggerLabel: null,
    sessionId: null,
    deliveryNote: null,
    startedAt: 0,
  },
];

const props = {
  routine,
  runs,
  agent: { id: "a1", name: "Research", avatar: "owl" },
  createdByName: "Elif Yılmaz",
  runningSince: null,
  channelLabels: { email: ["deniz@acme.test"], slack: [] },
  isOwner: true,
  onTogglePause: () => {},
  onDelete: () => {},
  onToggleShared: () => {},
  onRunNow: () => {},
  running: false,
  busy: false,
  editHref: "/routines/r1/edit",
};

const results = () =>
  within(screen.getByRole("table", { name: "Recent runs" }))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.textContent);

/** Opens the bar's ⋯ menu. */
async function openMenu() {
  await userEvent.click(screen.getByRole("button", { name: `More for ${routine.name}` }));
}

describe("RoutineDetail", () => {
  it("says what it is, whose agent runs it and what state it is in", () => {
    render(<RoutineDetail {...props} />);
    expect(screen.getByRole("heading", { name: routine.name })).toBeInTheDocument();
    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("lays out the schedule, the instructions and where it delivers", () => {
    render(<RoutineDetail {...props} />);
    expect(screen.getByText("Every hour · Europe/Istanbul")).toBeInTheDocument();
    expect(screen.getByText("0 * * * *")).toBeInTheDocument();
    expect(screen.getByText(/Elif Yılmaz ·/)).toBeInTheDocument();
    expect(screen.getByText("summarise new posts")).toBeInTheDocument();
    expect(screen.getByText("deniz@acme.test")).toBeInTheDocument();
    expect(screen.getByText(/sees the result as a thread/)).toBeInTheDocument();
  });

  // 0109: "why did this run at 03:12?" is answered on the row, beside when.
  it("says what started a run that something other than the schedule started", () => {
    const started = [
      { ...runs[0], id: "e", triggeredBy: "event" as const, triggerLabel: "Gmail · New mail" },
      { ...runs[1], id: "w", triggeredBy: "webhook" as const },
      { ...runs[2], id: "m", triggeredBy: "manual" as const },
    ];
    render(<RoutineDetail {...props} runs={started} />);
    const rows = results();
    expect(rows[0]).toMatch(/· Gmail · New mail/);
    expect(rows[1]).toMatch(/· Webhook/);
    expect(rows[2]).toMatch(/· Run now/);
  });

  it("says nothing extra for a scheduled run, which is the ordinary case", () => {
    render(<RoutineDetail {...props} runs={[{ ...runs[0], triggeredBy: "schedule" as const }]} />);
    expect(results()[0]).not.toMatch(/· (Webhook|Run now)/);
  });

  // An event routine is never due, so a cron in front of it would promise a
  // run that never happens.
  it("names what starts an event routine instead of a schedule", () => {
    const waiting = {
      ...routine,
      sourceKind: "none" as const,
      sourceUrl: null,
      triggerKind: "event" as const,
      event: {
        type: "gmail.new_message",
        provider: "composio",
        app: "Gmail",
        label: "New mail",
        config: {},
        status: "active" as const,
        statusDetail: null,
        lastEventAt: null,
        expiresAt: null,
      },
    };
    // Not the owner, so the event card — which reaches the API — is not drawn.
    render(<RoutineDetail {...props} routine={waiting} runs={[]} isOwner={false} />);
    expect(screen.getByText("When Gmail · New mail")).toBeInTheDocument();
    expect(screen.getByText("When the event arrives")).toBeInTheDocument();
    expect(screen.queryByText("Cron")).not.toBeInTheDocument();
    expect(screen.getByText(/the first one starts when the event arrives/)).toBeInTheDocument();
  });

  it("says what came of each run, neutrally where nothing failed", () => {
    render(<RoutineDetail {...props} />);
    const rows = results();
    expect(rows[0]).toMatch(/Done · 3 new items/);
    expect(rows[1]).toMatch(/No action needed/);
    expect(rows[2]).toMatch(/Failed · upstream 503/);
  });

  // The per-run cap delivers ten and marks everything it saw as seen, so the
  // rest are not queued for later — they are gone.
  it("says how many entries the per-run cap dropped", () => {
    render(<RoutineDetail {...props} runs={[{ ...runs[0], itemsNew: 10, itemsOverflow: 32 }]} />);
    expect(results()[0]).toMatch(/10 new items · 32 skipped/);
  });

  // "No action needed" and "nothing to report" are different answers to
  // "why didn't it send me anything?", and only one of them is a judgement.
  it("distinguishes a filtered run from an empty one, with what it read", () => {
    render(
      <RoutineDetail {...props} runs={[{ ...runs[1], nothingRelevant: true, itemsNew: 6 }]} />,
    );
    expect(results()[0]).toMatch(/Nothing to report · 6 reviewed/);
  });

  /** covan#243: the run completed, but the turn inside it stopped early. */
  it("says a run that was cut short did not finish", () => {
    render(<RoutineDetail {...props} runs={[{ ...runs[0], outcome: "cut_short" as const }]} />);
    expect(results()[0]).toMatch(/Stopped before it finished · 3 new items/);
  });

  it("opens a run's thread, or what it delivered when it has none", async () => {
    render(
      <RoutineDetail
        {...props}
        runs={[{ ...runs[0], id: "t", sessionId: "s1" }, runs[0], runs[1]]}
      />,
    );
    expect(screen.getByRole("link", { name: "Open" })).toBeInTheDocument();
    // A run that sent nothing has nothing to show.
    expect(screen.getAllByRole("button", { name: "Summary" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Summary" }));
    expect(await screen.findByText("Three new posts about pricing.")).toBeInTheDocument();
  });

  it("names a connection routine by the account it watches", () => {
    render(
      <RoutineDetail
        {...props}
        routine={{ ...routine, sourceKind: "connection", sourceUrl: null, connectionId: "cn1" }}
        connections={[{ id: "cn1", accountLabel: "Covan HQ", folderName: null } as never]}
      />,
    );
    expect(screen.getByText(/Covan HQ/)).toBeInTheDocument();
  });

  it("falls back to a readable phrase when the connection is unknown", () => {
    render(
      <RoutineDetail
        {...props}
        routine={{ ...routine, sourceKind: "connection", sourceUrl: null, connectionId: "gone" }}
      />,
    );
    expect(screen.getByText("A connected source")).toBeInTheDocument();
  });

  it("gives a teammate no controls, and says their delivery target is the owner's", () => {
    render(<RoutineDetail {...props} isOwner={false} channelLabels={null} editHref={undefined} />);
    expect(screen.queryByRole("button", { name: /pause/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /run now/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /more for/i })).not.toBeInTheDocument();
    expect(screen.getByText("The owner’s channel")).toBeInTheDocument();
  });

  // A finished series has nothing to pause and is not meant to be resumed.
  it("offers no pause or resume control on a completed routine", () => {
    render(<RoutineDetail {...props} routine={{ ...routine, status: "completed" }} />);
    expect(screen.queryByRole("button", { name: /pause/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /resume/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run now/i })).toBeInTheDocument();
    expect(screen.getAllByText("Finished").length).toBeGreaterThan(0);
    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
  });

  describe("run now", () => {
    it("runs on demand rather than making the user wait out the schedule", async () => {
      const onRunNow = vi.fn();
      render(<RoutineDetail {...props} onRunNow={onRunNow} />);
      await userEvent.click(screen.getByRole("button", { name: /run now/i }));
      expect(onRunNow).toHaveBeenCalledTimes(1);
    });

    // The run is synchronous and contains an LLM call. A button that still
    // says "Run now" invites a second click and a second delivery.
    it("says it is running and refuses a second click", () => {
      render(<RoutineDetail {...props} running />);
      expect(screen.getByRole("button", { name: /running/i })).toBeDisabled();
    });
  });

  describe("the menu", () => {
    it("shares a private routine with the team", async () => {
      const onToggleShared = vi.fn();
      render(<RoutineDetail {...props} onToggleShared={onToggleShared} />);
      await openMenu();
      await userEvent.click(await screen.findByRole("menuitem", { name: "Share with team" }));
      expect(onToggleShared).toHaveBeenCalledWith(true);
    });

    it("asks before deleting", async () => {
      const onDelete = vi.fn();
      render(<RoutineDetail {...props} onDelete={onDelete} />);
      await openMenu();
      await userEvent.click(await screen.findByRole("menuitem", { name: "Delete routine" }));
      await userEvent.click(await screen.findByRole("button", { name: "Delete routine" }));
      expect(onDelete).toHaveBeenCalled();
    });
  });

  /**
   * A4. Sharing is refused by `routines_workspace_source_private_check`
   * (0076) and filing by `routine_workspace_source_is_permitted` (0075/0076)
   * for `source_kind = 'workspace'`; offering either invites the refusal.
   */
  describe("a workspace-sourced routine", () => {
    const workspaceRoutine: Routine = { ...routine, sourceKind: "workspace", sourceUrl: null };

    it("offers no sharing and no filing, and says why", async () => {
      render(<RoutineDetail {...props} routine={workspaceRoutine} />);
      await openMenu();
      await screen.findByRole("menuitem", { name: "Delete routine" });
      expect(screen.queryByRole("menuitem", { name: /share/i })).not.toBeInTheDocument();
      expect(screen.queryByText("Keep a copy")).not.toBeInTheDocument();
      expect(screen.getByText(/never shared and never filed/i)).toBeInTheDocument();
    });

    it("keeps both for every other source kind", () => {
      render(<RoutineDetail {...props} />);
      expect(screen.getByText("Keep a copy")).toBeInTheDocument();
      expect(screen.queryByText(/never shared and never filed/i)).not.toBeInTheDocument();
    });
  });
});
