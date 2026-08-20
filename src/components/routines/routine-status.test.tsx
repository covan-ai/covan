import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoutineStatus } from "./routine-status";
import type { Routine } from "@/lib/routines-api";

const base: Routine = {
  id: "r1",
  agentId: "a1",
  userId: "u1",
  name: "Test",
  visibility: "private",
  sourceKind: "none",
  sourceUrl: null,
  instruction: "do a thing",
  deliveryChannelId: "c1",
  scheduleCron: "0 * * * *",
  timezone: "UTC",
  status: "active",
  pausedReason: null,
  nextRunAt: null,
  lastRunAt: null,
  createdAt: 0,
};

describe("RoutineStatus", () => {
  it("reads Active when running", () => {
    render(<RoutineStatus routine={base} />);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("reads a plain Paused when the user paused it", () => {
    render(<RoutineStatus routine={{ ...base, status: "paused" }} />);
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });

  // A routine the engine gave up on must not look like a deliberate pause —
  // that is the failure mode that destroys trust in the whole feature.
  it("surfaces the reason when the engine paused it after repeated failures", () => {
    render(<RoutineStatus routine={{ ...base, status: "paused", pausedReason: "upstream 503" }} />);
    expect(screen.getByText(/upstream 503/)).toBeInTheDocument();
  });
});
