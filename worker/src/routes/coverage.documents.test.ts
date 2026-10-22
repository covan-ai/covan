import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { activeWorkspaceTables, fakeDb } from "../test-support/fake-db";
import { coverage } from "./coverage";

const USER = { id: "user-1", email: "ada@acme.test" };
const WORKSPACE_ID = "workspace-1";

function appFor(db: unknown) {
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", db as never);
    await next();
  });
  app.route("/", coverage);
  return app;
}

describe("one agent, and the documents worth revisiting (0134)", () => {
  it("narrows the bars and the totals to the agent asked for", async () => {
    const { db } = fakeDb({
      tables: activeWorkspaceTables(USER.id, WORKSPACE_ID),
      rpc: {
        workspace_coverage: () => ({
          data: [{ answers: 100, covered: 50, fallback: 30, ungrounded: 10, unrecorded: 10 }],
          error: null,
        }),
        workspace_coverage_agents: () => ({
          data: [
            {
              agent_id: "a1",
              agent_name: "Support",
              agent_emoji: null,
              agent_avatar: "headset",
              answers: 60,
              covered: 30,
              fallback: 25,
              ungrounded: 5,
            },
            {
              agent_id: "a2",
              agent_name: "Research",
              agent_emoji: null,
              agent_avatar: null,
              answers: 40,
              covered: 20,
              fallback: 5,
              ungrounded: 5,
            },
          ],
          error: null,
        }),
      },
    });
    const res = await appFor(db).request("/coverage/workspace?days=30&agentId=a1");
    const body = (await res.json()) as {
      totals: unknown;
      agents: Array<{ agentId: string; avatar: unknown }>;
    };
    expect(body.agents.map((a) => [a.agentId, a.avatar])).toEqual([["a1", "headset"]]);
    expect(body.totals).toEqual({
      answers: 60,
      covered: 30,
      fallback: 25,
      ungrounded: 5,
      unrecorded: 0,
    });
  });

  it("lists old documents that replies still cite, most used first, with who reads them", async () => {
    const old = "2025-08-01T00:00:00Z";
    const { db } = fakeDb({
      tables: {
        ...activeWorkspaceTables(USER.id, WORKSPACE_ID),
        knowledge_bundles: {
          select: () => ({ data: [{ id: "b1", name: "Policies" }], error: null }),
        },
        documents: {
          select: (ctx) => {
            expect(ctx.filters.some((f) => f.kind === "lt" && f.column === "created_at")).toBe(
              true,
            );
            return {
              data: [
                { id: "d1", name: "Shipping SLA.docx", bundle_id: "b1", created_at: old },
                { id: "d2", name: "Refund policy v3.pdf", bundle_id: "b1", created_at: old },
              ],
              error: null,
            };
          },
        },
        agent_bundles: {
          select: () => ({
            data: [
              {
                bundle_id: "b1",
                agent: { id: "a1", name: "Support", avatar: "headset", deleted_at: null },
              },
              { bundle_id: "b1", agent: { id: "a9", name: "Gone", avatar: null, deleted_at: old } },
            ],
            error: null,
          }),
        },
      },
      rpc: {
        document_citation_counts_since: () => ({
          data: [
            { document_id: "d1", citations: 38 },
            { document_id: "d2", citations: 61 },
          ],
          error: null,
        }),
      },
    });
    const res = await appFor(db).request("/coverage/documents?days=30");
    const body = (await res.json()) as { documents: Array<Record<string, unknown>> };
    expect(body.documents.map((d) => [d.name, d.uses])).toEqual([
      ["Refund policy v3.pdf", 61],
      ["Shipping SLA.docx", 38],
    ]);
    expect(body.documents[0]).toMatchObject({
      bundleName: "Policies",
      readBy: [{ agentId: "a1", name: "Support", avatar: "headset" }],
    });
  });
});
