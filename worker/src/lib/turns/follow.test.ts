import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineEnv } from "../../types";

const settle = vi.fn();
// A plain flag rather than a rejecting mock: Vitest reports a mock's rejection
// as the test's own failure even when the code under test catches it.
let failNext = false;
vi.mock("../browser/live", () => ({
  settleConversationBrowser: async (...args: unknown[]) => {
    if (failNext) {
      failNext = false;
      throw new Error("provider down");
    }
    return settle(...args);
  },
}));

const { FOLLOW_FOR_MS, followFrom, followOnce } = await import("./follow");

const env = {} as RoutineEnv;

beforeEach(() => settle.mockReset());

describe("following a turn's browser after the turn", () => {
  it("looks again while the run is still going", async () => {
    settle.mockResolvedValue({ running: true });
    const follow = followFrom({ sessionId: "s1", userId: "u1" }, 0);

    expect(await followOnce(env, follow, 1_000)).toBe(true);
    expect(settle).toHaveBeenCalledWith(env, { chatSessionId: "s1", userId: "u1" });
  });

  it("stops once the run has ended, or when there never was one", async () => {
    settle.mockResolvedValue({ running: false });
    expect(await followOnce(env, followFrom({ sessionId: "s1", userId: "u1" }, 0), 1_000)).toBe(
      false,
    );
  });

  it("gives the run back to the cron once it has followed for long enough", async () => {
    settle.mockResolvedValue({ running: true });
    const follow = followFrom({ sessionId: "s1", userId: "u1" }, 0);
    expect(await followOnce(env, follow, FOLLOW_FOR_MS + 1)).toBe(false);
  });

  it("does not let a failed look end the following early", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    failNext = true;
    const follow = followFrom({ sessionId: "s1", userId: "u1" }, 0);
    expect(await followOnce(env, follow, 1_000)).toBe(true);
  });
});
