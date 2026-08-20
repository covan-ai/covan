import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoutinesList } from "./routines-list";
import type { Routine } from "@/lib/routines-api";

// RoutinesList renders TanStack Router <Link>s, which need a router context this
// test has no reason to build. Stubbing Link to an anchor keeps the test about
// grouping and copy.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));

const routine = (over: Partial<Routine>): Routine => ({
  id: "r1",
  agentId: "a1",
  userId: "me",
  name: "r/SaaS new posts",
  visibility: "private",
  sourceKind: "rss",
  sourceUrl: "https://example.com/feed.xml",
  instruction: "summarise",
  deliveryChannelId: "c1",
  scheduleCron: "0 * * * *",
  timezone: "UTC",
  status: "active",
  pausedReason: null,
  nextRunAt: null,
  lastRunAt: null,
  createdAt: 0,
  ...over,
});

describe("RoutinesList", () => {
  it("shows the schedule in prose, never as a cron expression", () => {
    render(
      <RoutinesList
        agentId="a1"
        currentUserId="me"
        memberNames={{}}
        routines={[routine({ scheduleCron: "*/5 * * * *" })]}
        action={null}
      />,
    );

    expect(screen.getByText("Every 5 minutes")).toBeInTheDocument();
    expect(screen.queryByText("*/5 * * * *")).not.toBeInTheDocument();
  });

  it("separates a teammate's shared routine from the caller's own", () => {
    render(
      <RoutinesList
        agentId="a1"
        currentUserId="me"
        memberNames={{ other: "Efe" }}
        routines={[
          routine({ id: "mine", name: "Mine" }),
          routine({ id: "theirs", name: "Theirs", userId: "other", visibility: "shared" }),
        ]}
        action={null}
      />,
    );

    expect(screen.getByText("Team routines")).toBeInTheDocument();
    expect(screen.getByText("My routines")).toBeInTheDocument();
    expect(screen.getByText("by Efe")).toBeInTheDocument();
  });

  it("drops routines belonging to other agents", () => {
    render(
      <RoutinesList
        agentId="a1"
        currentUserId="me"
        memberNames={{}}
        routines={[
          routine({ id: "here" }),
          routine({ id: "elsewhere", agentId: "a2", name: "Elsewhere" }),
        ]}
        action={null}
      />,
    );

    expect(screen.queryByText("Elsewhere")).not.toBeInTheDocument();
  });
});
