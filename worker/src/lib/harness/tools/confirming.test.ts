import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext, ToolEnv } from "../registry";
import { sendEmailTool } from "./send-email";
import { scheduleJobTool } from "./schedule-job";

/**
 * The two tools that change the world, and the thing they have in common:
 * neither does anything the first time it is called.
 *
 * `needs_confirmation` is the whole mechanism, and it is general rather than
 * scheduling-shaped on purpose — 0058's `ask -> pending -> approved` needs
 * exactly this, and building it twice would mean going through every tool a
 * second time.
 */
const deliver = vi.fn(async () => {});
vi.mock("../../routines/delivery", () => ({
  deliver: () => deliver(),
  deliveryDepsFrom: () => ({}),
}));

const deliveryChannelSecret = vi.fn(async () => ({
  kind: "email",
  secret_ciphertext: "v1.x.y",
}));
vi.mock("../secrets", () => ({
  deliveryChannelSecret: () => deliveryChannelSecret(),
}));

const createRoutine = vi.fn(async (_db: unknown, _input: Record<string, unknown>) => ({
  ok: true as boolean,
  row: { id: "r1" },
  status: 400 as const,
  message: "",
}));
vi.mock("../../routines/create", () => ({
  createRoutine: (db: unknown, input: Record<string, unknown>) => createRoutine(db, input),
}));

const CHANNEL = { id: "chan-1", kind: "email", label: "a••••a@covan.test" };

function ctxWith(channel: Record<string, unknown> | null, confirmed = false): ToolContext {
  return {
    db: {
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: channel, error: null }) }) }),
        }),
      }),
    } as unknown as ToolContext["db"],
    env: {
      ALLOWED_ORIGIN: "https://app.covan.test",
      ROUTINE_SECRET_KEY: "k",
      RESEND_API_KEY: "re",
      RESEND_FROM: "R <r@e.com>",
    } as ToolEnv,
    workspaceId: "ws-1",
    agentId: "agent-1",
    userId: "user-1",
    confirmed,
  };
}

beforeEach(() => {
  deliver.mockClear();
  createRoutine.mockClear();
});

describe("send_email", () => {
  const args = { channelId: "chan-1", subject: "Yesterday's orders", body: "Forty." };

  it("asks first, and sends nothing while it is asking", async () => {
    const result = await sendEmailTool.run(args, ctxWith(CHANNEL));
    expect(result).toMatchObject({ kind: "needs_confirmation" });
    expect((result as { summary: string }).summary).toContain("Yesterday's orders");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("sends once a person has said yes", async () => {
    const result = await sendEmailTool.run(args, ctxWith(CHANNEL, true));
    expect(result).toMatchObject({ kind: "ok" });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  /**
   * The ceiling on what an injected instruction can achieve. The model names
   * a channel, never an address, and the channel has to be one belonging to
   * the person the turn is running for.
   */
  it("refuses a channel that is not this person's, before it asks anybody", async () => {
    const result = await sendEmailTool.run(args, ctxWith(null));
    expect(result).toEqual({ kind: "error", message: "no such channel belongs to this person" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("is unavailable on a deployment that cannot send mail", async () => {
    expect(sendEmailTool.isConfigured({ ROUTINE_SECRET_KEY: "k" } as ToolEnv)).toBe(false);
  });
});

describe("schedule_job", () => {
  const args = {
    name: "Monday orders",
    instruction: "Query the orders database and report the week.",
    cron: "0 17 * * 1",
    timezone: "Europe/Istanbul",
    channelId: "chan-1",
  };

  it("proposes rather than creates, and says when it would first run", async () => {
    const result = await scheduleJobTool.run(args, ctxWith(CHANNEL));
    expect(result).toMatchObject({ kind: "needs_confirmation" });
    expect((result as { proposal: { firstRunAt: string } }).proposal.firstRunAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
    expect(createRoutine).not.toHaveBeenCalled();
  });

  it("creates an ordinary routine with no source once approved", async () => {
    const result = await scheduleJobTool.run(args, ctxWith(CHANNEL, true));
    expect(result).toMatchObject({ kind: "ok" });
    // The routine holds the clock; the agent fetches. A source here would be
    // a new source_kind for every service, which is the coupling this design
    // exists to avoid.
    expect(createRoutine.mock.calls[0][1]).toMatchObject({
      sourceKind: "none",
      agentId: "agent-1",
      workspaceId: "ws-1",
      userId: "user-1",
      deliveryChannelId: "chan-1",
      scheduleCron: "0 17 * * 1",
      timezone: "Europe/Istanbul",
    });
  });

  /**
   * Checked before a person is asked, not after they say yes. A proposal
   * somebody approves and that then fails validation is the worst order to
   * do this in — the decision has already been made.
   */
  it("refuses an unparseable schedule before anybody is asked about it", async () => {
    const result = await scheduleJobTool.run({ ...args, cron: "nonsense every day" }, ctxWith(CHANNEL));
    expect(result).toMatchObject({ kind: "error" });
    expect(createRoutine).not.toHaveBeenCalled();
  });

  it("refuses a timezone the schedule cannot be read in", async () => {
    const result = await scheduleJobTool.run(
      { ...args, timezone: "Mars/Olympus" },
      ctxWith(CHANNEL),
    );
    expect(result).toMatchObject({ kind: "error" });
  });

  it("refuses a channel that is not this person's", async () => {
    const result = await scheduleJobTool.run(args, ctxWith(null));
    expect(result).toMatchObject({ kind: "error" });
  });

  it("hands back the reason the insert was refused, rather than a shrug", async () => {
    createRoutine.mockResolvedValue({
      ok: false,
      status: 400,
      message: "the delivery channel is not available to you",
    } as never);
    const result = await scheduleJobTool.run(args, ctxWith(CHANNEL, true));
    expect((result as { message: string }).message).toContain("not available to you");
  });
});
