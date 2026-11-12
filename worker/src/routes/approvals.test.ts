import { Hono } from "hono";
import { describe, it, expect } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type FakeDbSpec } from "../test-support/fake-db";
import { approvals } from "./approvals";

const ID = "4b1f7c0e-2d7a-4c55-9b7e-0d6a1f3e9c21";

const REQUEST = {
  id: ID,
  origin: "routine",
  tool: "http_request",
  summary: "POST to Box office?",
  proposal: { method: "POST", path: "/seats/14/close" },
  status: "pending",
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  created_at: "2026-11-13T03:00:00.000Z",
  resolved_at: null,
  resolved_by: null,
  resolved_via: null,
  resumed_at: null,
  user_id: "owner-1",
  agent_id: "agent-1",
  routine_run_id: "run-1",
  session_id: "conv-1",
};

function appAs(user: string, spec: FakeDbSpec, apiKeyId?: string) {
  const fake = fakeDb(spec);
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: user } as never);
    c.set("db", fake.db as never);
    if (apiKeyId) c.set("apiKeyId", apiKeyId);
    await next();
  });
  app.route("/", approvals);
  return app;
}

function reading(row: Record<string, unknown> | null): FakeDbSpec {
  return {
    tables: {
      paused_turns: { select: () => ({ data: row, error: null }) },
      agents: { select: () => ({ data: { id: "agent-1", name: "Box office" }, error: null }) },
      profiles: {
        select: () => ({
          data: [
            { id: "owner-1", name: "Ada" },
            { id: "admin-1", name: "Grace" },
          ],
          error: null,
        }),
      },
      routine_runs: { select: () => ({ data: { routine_id: "routine-1" }, error: null }) },
      routines: {
        select: () => ({ data: { id: "routine-1", name: "Seat requests" }, error: null }),
      },
    },
  };
}

describe("GET /approvals/:id", () => {
  it("shows the owner their request, with the buttons and the way into the thread", async () => {
    const res = await appAs("owner-1", reading(REQUEST)).request(`/approvals/${ID}`);
    expect(res.status).toBe(200);
    const { approval } = (await res.json()) as { approval: Record<string, unknown> };
    expect(approval).toMatchObject({
      id: ID,
      summary: "POST to Box office?",
      mine: true,
      canAnswer: true,
      sessionId: "conv-1",
      agent: { id: "agent-1", name: "Box office" },
      routine: { id: "routine-1", name: "Seat requests" },
      owner: { id: "owner-1", name: "Ada" },
      resolvedBy: null,
    });
  });

  it("lets an admin answer a routine's request without sending them into its thread", async () => {
    const res = await appAs("admin-1", reading(REQUEST)).request(`/approvals/${ID}`);
    const { approval } = (await res.json()) as { approval: Record<string, unknown> };
    expect(approval).toMatchObject({ mine: false, canAnswer: true, sessionId: null });
  });

  it("offers no buttons on a woken conversation's request to anyone but its owner", async () => {
    const res = await appAs(
      "colleague-1",
      reading({ ...REQUEST, origin: "wake", routine_run_id: null }),
    ).request(`/approvals/${ID}`);
    const { approval } = (await res.json()) as { approval: Record<string, unknown> };
    expect(approval.canAnswer).toBe(false);
  });

  it("offers no buttons once it was answered, and says by whom", async () => {
    const res = await appAs(
      "owner-1",
      reading({
        ...REQUEST,
        status: "approved",
        resolved_by: "admin-1",
        resolved_via: "app",
        resolved_at: "2026-11-13T07:00:00.000Z",
      }),
    ).request(`/approvals/${ID}`);
    const { approval } = (await res.json()) as { approval: Record<string, unknown> };
    expect(approval).toMatchObject({
      canAnswer: false,
      status: "approved",
      resolvedVia: "app",
      resolvedBy: { id: "admin-1", name: "Grace" },
    });
  });

  it("is a 404 for what the caller may not see", async () => {
    const res = await appAs("stranger-1", reading(null)).request(`/approvals/${ID}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /approvals/:id/answer", () => {
  const answer = (app: Hono<AppEnv>, approve: boolean, id = ID) =>
    app.request(`/approvals/${id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approve }),
    });

  function answering(result: { data: unknown; error: { code: string; message: string } | null }) {
    const asked: Array<Record<string, unknown>> = [];
    return {
      asked,
      spec: {
        rpc: {
          answer_approval: (args: Record<string, unknown>) => {
            asked.push(args);
            return result;
          },
        },
      } satisfies FakeDbSpec,
    };
  }

  it("writes the answer through the caller's own client, and nothing else", async () => {
    const { asked, spec } = answering({ data: "approved", error: null });
    const res = await answer(appAs("owner-1", spec), true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "approved" });
    expect(asked).toEqual([{ p_id: ID, p_approve: true }]);
  });

  it("refuses an API key before it touches anything", async () => {
    const { asked, spec } = answering({ data: "approved", error: null });
    const res = await answer(appAs("owner-1", spec, "key-1"), true);
    expect(res.status).toBe(403);
    expect(asked).toEqual([]);
  });

  for (const [what, result, status] of [
    ["somebody else's", { data: null, error: { code: "42501", message: "" } }, 403],
    ["one the caller cannot see", { data: null, error: { code: "P0002", message: "" } }, 404],
    ["a conversation's question", { data: null, error: { code: "22023", message: "" } }, 409],
    ["one already answered", { data: "already", error: null }, 409],
    ["one that has expired", { data: "expired", error: null }, 410],
  ] as const) {
    it(`answers ${status} for ${what}`, async () => {
      const { spec } = answering(result as never);
      expect((await answer(appAs("owner-1", spec), false)).status).toBe(status);
    });
  }

  it("asks nothing for an id that is not a request's", async () => {
    const { asked, spec } = answering({ data: "approved", error: null });
    expect((await answer(appAs("owner-1", spec), true, "nope")).status).toBe(404);
    expect(asked).toEqual([]);
  });
});
