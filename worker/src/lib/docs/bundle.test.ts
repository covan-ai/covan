import { describe, expect, it } from "vitest";
import { fakeDb } from "../../test-support/fake-db";
import { ensureReportBundle, reportBundleMarker } from "./bundle";

const INPUT = { workspaceId: "ws-1", agentId: "agent-1", agentName: "Finance", userId: "user-1" };

describe("ensureReportBundle", () => {
  it("finds the bundle the browser made, by the same marker", async () => {
    const fake = fakeDb({
      tables: {
        knowledge_bundles: { select: () => ({ data: [{ id: "bundle-1" }], error: null }) },
        agent_bundles: { select: () => ({ data: { bundle_id: "bundle-1" }, error: null }) },
      },
    });

    expect(await ensureReportBundle(fake.db as never, INPUT)).toEqual({
      ok: true,
      bundleId: "bundle-1",
    });
    const find = fake.callsTo("knowledge_bundles")[0];
    expect(find.filters).toContainEqual(
      expect.objectContaining({ column: "description", value: reportBundleMarker("agent-1") }),
    );
    expect(find.filters).toContainEqual(
      expect.objectContaining({ column: "workspace_id", value: "ws-1" }),
    );
  });

  it("makes and attaches one when there is none", async () => {
    const fake = fakeDb({
      tables: {
        knowledge_bundles: {
          select: () => ({ data: [], error: null }),
          insert: () => ({ data: { id: "bundle-2" }, error: null }),
        },
        agent_bundles: {
          select: () => ({ data: null, error: null }),
          insert: () => ({ data: null, error: null }),
        },
      },
    });

    expect(await ensureReportBundle(fake.db as never, INPUT)).toEqual({
      ok: true,
      bundleId: "bundle-2",
    });
    expect(fake.callsTo("knowledge_bundles")[1].values).toMatchObject({
      name: "Finance — reports",
      description: "covan:reports:agent-1",
      created_by: "user-1",
    });
    expect(fake.callsTo("agent_bundles")[1].values).toEqual({
      agent_id: "agent-1",
      bundle_id: "bundle-2",
    });
  });

  it("answers a viewer's refused insert in words", async () => {
    const fake = fakeDb({
      tables: {
        knowledge_bundles: {
          select: () => ({ data: [], error: null }),
          insert: () => ({ data: null, error: { message: "denied", code: "42501" } }),
        },
      },
    });

    const result = await ensureReportBundle(fake.db as never, INPUT);
    expect(result.ok).toBe(false);
  });
});
