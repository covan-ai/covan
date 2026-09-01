import { describe, it, expect } from "vitest";
import { firstWeekSteps, firstWeekRemaining, type FirstWeekInput } from "./first-week";
import type { Agent, ChatSession } from "./agents-store";

const agent = (documents: number): Agent =>
  ({
    id: "agent-1",
    documents: Array.from({ length: documents }, (_, i) => ({ id: `doc-${i}` })),
  }) as unknown as Agent;

const session = (messageCount: number): ChatSession =>
  ({ id: "session-1", messageCount }) as unknown as ChatSession;

const input = (patch: Partial<FirstWeekInput> = {}): FirstWeekInput => ({
  agents: [agent(0)],
  sessions: [],
  memberCount: 1,
  routineCount: 0,
  ...patch,
});

const step = (i: FirstWeekInput, key: string) => firstWeekSteps(i).find((s) => s.key === key)!;

describe("firstWeekSteps", () => {
  it("has nothing ticked for a workspace that has only made an agent", () => {
    expect(firstWeekRemaining(firstWeekSteps(input()))).toBe(4);
  });

  it("counts a document on any agent, not only the first", () => {
    expect(step(input({ agents: [agent(0), agent(3)] }), "knowledge").done).toBe(true);
  });

  // Opening the composer starts a session before anybody has said anything, so
  // counting sessions would tick this for a workspace that has never asked a
  // question — which is the one thing the step is asking about.
  it("does not count an empty session as having asked something", () => {
    expect(step(input({ sessions: [session(0)] }), "ask").done).toBe(false);
    expect(step(input({ sessions: [session(0), session(2)] }), "ask").done).toBe(true);
  });

  // A pending invitation is not a teammate. With no RESEND_API_KEY it is a row
  // nobody has been told about, and this step's whole question is whether
  // anyone actually arrived.
  it("ticks the team step on membership, and the workspace's founder is not company", () => {
    expect(step(input({ memberCount: 1 }), "team").done).toBe(false);
    expect(step(input({ memberCount: 2 }), "team").done).toBe(true);
  });

  it("ticks the routine step as soon as one exists", () => {
    expect(step(input({ routineCount: 1 }), "routine").done).toBe(true);
  });

  it("has nothing left once all four are true", () => {
    const steps = firstWeekSteps(
      input({ agents: [agent(1)], sessions: [session(4)], memberCount: 3, routineCount: 1 }),
    );
    expect(firstWeekRemaining(steps)).toBe(0);
  });
});
