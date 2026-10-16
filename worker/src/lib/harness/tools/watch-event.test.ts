import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memoryDb } from "../../../test-support/memory-db";
import type { ToolContext } from "../registry";

const replaceSubscription = vi.fn(
  async (..._args: unknown[]): Promise<{ status: string | null; detail: string | null }> => ({
    status: "active",
    detail: null,
  }),
);
vi.mock("../../routines/events/lifecycle", () => ({
  replaceSubscription: (...args: unknown[]) => replaceSubscription(...args),
}));

const { watchEventTool } = await import("./watch-event");

const CHANNEL = { id: "c1", user_id: "u1", kind: "email", label: "a••••@example.com" };
const ENV = { ALLOWED_ORIGIN: "https://app.example.com" } as never;

function ctx(over: Partial<ToolContext> = {}) {
  const m = memoryDb({ delivery_channels: [CHANNEL], routines: [] });
  return {
    m,
    ctx: {
      db: m.db as unknown as SupabaseClient,
      env: ENV,
      workspaceId: "w1",
      agentId: "a1",
      userId: "u1",
      ...over,
    } satisfies ToolContext,
  };
}

const ARGS = {
  name: "Deploy notes",
  instruction: "Summarise what changed in this push for the team.",
  event: "github.push",
  config: { branch: "main" },
  channelId: "c1",
};

beforeEach(() => replaceSubscription.mockClear());

describe("watch_event", () => {
  it("lists the events it can propose, and never one that needs a pasted credential", () => {
    expect(watchEventTool.description).toContain("github.push");
    expect(watchEventTool.description).not.toContain("telegram.new_message");
  });

  it("asks first, with the event as the catalogue checked it", async () => {
    const { ctx: c } = ctx();
    const out = await watchEventTool.run(ARGS, c);
    expect(out).toMatchObject({
      kind: "needs_confirmation",
      proposal: {
        kind: "watch_event",
        event: { type: "github.push", app: "GitHub", config: { branch: "main" } },
        channel: { id: "c1" },
      },
    });
    expect(replaceSubscription).not.toHaveBeenCalled();
  });

  it("makes an event routine and its subscription once approved", async () => {
    const { m, ctx: c } = ctx({ confirmed: true });
    const out = await watchEventTool.run(ARGS, c);

    expect(out).toMatchObject({ kind: "ok", content: expect.stringMatching(/webhook/) });
    const row = m.tables.routines[0];
    expect(row).toMatchObject({
      name: "Deploy notes",
      trigger_kind: "event",
      source_kind: "none",
      delivery_channel_id: "c1",
      user_id: "u1",
    });
    const [, routineId, choice] = replaceSubscription.mock.calls[0] as [
      unknown,
      string,
      { def: { id: string }; config: unknown },
    ];
    expect(routineId).toBe(row.id);
    expect(choice.def.id).toBe("github.push");
    expect(choice.config).toEqual({ branch: "main" });
  });

  it("removes the routine again if the subscription cannot be recorded", async () => {
    replaceSubscription.mockRejectedValueOnce(new Error("db down"));
    const { m, ctx: c } = ctx({ confirmed: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await watchEventTool.run(ARGS, c);
    error.mockRestore();
    expect(out).toMatchObject({ kind: "error" });
    expect(m.tables.routines).toHaveLength(0);
  });

  it("refuses an event that needs a credential, an unknown one, a bad filter, or a stranger's channel", async () => {
    const { ctx: c } = ctx({ confirmed: true });
    expect(await watchEventTool.run({ ...ARGS, event: "telegram.new_message" }, c)).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/credential/),
    });
    expect(await watchEventTool.run({ ...ARGS, event: "nope.nothing" }, c)).toMatchObject({
      kind: "error",
    });
    expect(
      await watchEventTool.run(
        { ...ARGS, event: "github.pull_request", config: { action: "sometimes" } },
        c,
      ),
    ).toMatchObject({ kind: "error", message: expect.stringMatching(/^action/) });
    expect(await watchEventTool.run({ ...ARGS, channelId: "c-other" }, c)).toMatchObject({
      kind: "error",
      message: "no such channel belongs to this person",
    });
    expect(replaceSubscription).not.toHaveBeenCalled();
  });
});
