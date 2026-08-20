import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoutineDetail } from "./routine-detail";
import type { Routine, RoutineRun } from "@/lib/routines-api";

const routine: Routine = {
  id: "r1",
  agentId: "a1",
  userId: "me",
  name: "r/SaaS new posts",
  visibility: "private",
  sourceKind: "rss",
  sourceUrl: "https://example.com/feed.xml",
  instruction: "summarise new posts",
  deliveryChannelId: "c1",
  scheduleCron: "0 * * * *",
  timezone: "Europe/Istanbul",
  status: "active",
  pausedReason: null,
  nextRunAt: null,
  lastRunAt: null,
  createdAt: 0,
};

const runs: RoutineRun[] = [
  {
    id: "1",
    status: "ok",
    itemsNew: 3,
    durationMs: 1400,
    error: null,
    summary: "Three new posts about pricing.",
    startedAt: 0,
  },
  {
    id: "2",
    status: "skipped",
    itemsNew: 0,
    durationMs: 300,
    error: null,
    summary: null,
    startedAt: 0,
  },
  {
    id: "3",
    status: "failed",
    itemsNew: 0,
    durationMs: 2100,
    error: "upstream 503",
    summary: null,
    startedAt: 0,
  },
];

const props = {
  routine,
  runs,
  channelLabel: "m…a@gmail.com",
  isOwner: true,
  onTogglePause: () => {},
  onDelete: () => {},
  onToggleShared: () => {},
  onRunNow: () => {},
  running: false,
  busy: false,
};

describe("RoutineDetail", () => {
  it("renders skipped neutrally, not as an error", () => {
    render(<RoutineDetail {...props} />);
    const row = screen.getByText("Nothing new");
    expect(row.className).toContain("text-muted-foreground");
    expect(row.className).not.toContain("rose");
  });

  it("shows a failed run's error", () => {
    render(<RoutineDetail {...props} />);
    expect(screen.getByText("upstream 503")).toBeInTheDocument();
  });

  it("hides owner controls for a teammate's routine", () => {
    render(<RoutineDetail {...props} isOwner={false} channelLabel={null} />);
    expect(screen.queryByRole("button", { name: /pause/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
  });

  // Delivery channels are scoped by RLS to their owner, so a teammate's target
  // is genuinely unreadable — say so rather than render an empty field.
  it("explains that a teammate's delivery target is not visible", () => {
    render(<RoutineDetail {...props} isOwner={false} channelLabel={null} />);
    expect(screen.getByText("The owner's channel")).toBeInTheDocument();
  });

  describe("run now", () => {
    it("runs on demand rather than making the user wait out the schedule", async () => {
      const onRunNow = vi.fn();
      const user = userEvent.setup();
      render(<RoutineDetail {...props} onRunNow={onRunNow} />);

      await user.click(screen.getByRole("button", { name: /run now/i }));
      expect(onRunNow).toHaveBeenCalledTimes(1);
    });

    // The run is synchronous and contains an LLM call, so it can take a while.
    // A button that still says "Run now" invites a second click and a second
    // delivery.
    it("says it is running and refuses a second click", () => {
      render(<RoutineDetail {...props} running />);
      expect(screen.getByRole("button", { name: /running/i })).toBeDisabled();
    });

    it("gives a teammate no way to run someone else's routine", () => {
      render(<RoutineDetail {...props} isOwner={false} channelLabel={null} />);
      expect(screen.queryByRole("button", { name: /run now/i })).not.toBeInTheDocument();
    });
  });

  describe("run history", () => {
    // "Sent · 3 new items" says a delivery happened but not what was in it. If
    // the mail never arrived, this is the only remaining copy.
    it("keeps the summary out of the way until asked for", async () => {
      const user = userEvent.setup();
      render(<RoutineDetail {...props} />);

      expect(screen.queryByText("Three new posts about pricing.")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /3 new items/i }));
      expect(screen.getByText("Three new posts about pricing.")).toBeInTheDocument();
    });

    it("does not offer to expand a run that sent nothing", () => {
      render(<RoutineDetail {...props} />);
      expect(screen.queryByRole("button", { name: /nothing new/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /upstream 503/i })).not.toBeInTheDocument();
    });

    // Runs recorded before routine_runs.summary existed carry null, and there
    // is nothing to backfill them with.
    it("does not offer to expand a delivered run from before summaries were kept", () => {
      render(<RoutineDetail {...props} runs={[{ ...runs[0], summary: null }]} />);
      expect(screen.queryByRole("button", { name: /3 new items/i })).not.toBeInTheDocument();
      // The count is still on screen, just as plain text split across spans
      // rather than a button — so match the row, not a single text node.
      expect(screen.getByRole("listitem")).toHaveTextContent("Sent · 3 new items");
    });
  });

  describe("sharing", () => {
    it("says a private routine is only visible to its owner", () => {
      render(<RoutineDetail {...props} />);
      expect(screen.getByText("Only you")).toBeInTheDocument();
    });

    it("says a shared routine is visible to the workspace", () => {
      render(<RoutineDetail {...props} routine={{ ...routine, visibility: "shared" }} />);
      expect(screen.getByText("Visible to everyone in the workspace")).toBeInTheDocument();
    });

    it("shares on toggle", async () => {
      const onToggleShared = vi.fn();
      const user = userEvent.setup();
      render(<RoutineDetail {...props} onToggleShared={onToggleShared} />);

      await user.click(screen.getByRole("switch", { name: /share with the workspace/i }));
      expect(onToggleShared).toHaveBeenCalledWith(true);
    });

    // A teammate can reach a shared routine but must not be able to unshare it;
    // the PATCH would be refused by RLS anyway, so offering the control would
    // only produce an error they cannot act on.
    it("gives a teammate no way to change visibility", () => {
      render(<RoutineDetail {...props} isOwner={false} channelLabel={null} />);
      expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    });
  });
});
