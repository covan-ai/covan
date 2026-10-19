import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./supabase", () => ({ serviceClient: () => service.current }));

import type { RoutineEnv } from "../types";
import { nearestPassages, putPassages, syncPassageVectors } from "./passages";

const env = {
  SUPABASE_URL: "u",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  OPENAI_API_KEY: "o",
} as unknown as RoutineEnv;

function fakeIndex() {
  return {
    upsert: vi.fn().mockResolvedValue({ mutationId: "m" }),
    deleteByIds: vi.fn().mockResolvedValue({ mutationId: "m" }),
    getByIds: vi.fn().mockResolvedValue([]),
    query: vi.fn().mockResolvedValue({ matches: [], count: 0 }),
  };
}

/**
 * A service client answering the two reads `syncPassageVectors` makes, and
 * recording its writes.
 */
function fakeService(opts: { changes?: unknown[]; inline?: unknown[][] }) {
  const inlinePages = [...(opts.inline ?? [])];
  const cleared: { table: string; filter: unknown }[] = [];
  const nulled: string[][] = [];
  const client = {
    from: (table: string) => {
      if (table === "passage_vector_changes") {
        return {
          select: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: opts.changes ?? [], error: null }),
            }),
          }),
          delete: () => ({
            lte: (_col: string, id: number) => {
              cleared.push({ table, filter: id });
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      return {
        select: () => ({
          not: () => ({
            limit: () => Promise.resolve({ data: inlinePages.shift() ?? [], error: null }),
          }),
        }),
        update: (patch: unknown) => ({
          in: (_col: string, ids: string[]) => {
            expect(patch).toEqual({ embedding: null });
            nulled.push(ids);
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  };
  return { client, cleared, nulled };
}

beforeEach(() => {
  service.current = null;
});

describe("putPassages", () => {
  it("writes a thousand at a time with the bundle to filter on", async () => {
    const index = fakeIndex();
    const vectors = Array.from({ length: 1500 }, (_, i) => ({
      id: `c${i}`,
      workspaceId: "w",
      bundleId: "b",
      documentId: "d",
      values: [i],
    }));

    await putPassages(index as never, vectors);

    expect(index.upsert).toHaveBeenCalledTimes(2);
    expect(index.upsert.mock.calls[0][0]).toHaveLength(1000);
    expect(index.upsert.mock.calls[0][0][0]).toEqual({
      id: "c0",
      values: [0],
      metadata: { bundle_id: "b", document_id: "d", workspace_id: "w" },
    });
  });
});

describe("nearestPassages", () => {
  it("asks for nothing when no bundle may be read", async () => {
    const index = fakeIndex();
    expect(await nearestPassages(index as never, [1], [], 40)).toEqual([]);
    expect(index.query).not.toHaveBeenCalled();
  });

  it("filters by the one bundle, or by the list", async () => {
    const index = fakeIndex();
    await nearestPassages(index as never, [1], ["b1"], 40);
    await nearestPassages(index as never, [1], ["b1", "b2"], 40);

    expect(index.query.mock.calls[0][1]).toMatchObject({
      topK: 40,
      returnValues: false,
      returnMetadata: "none",
      filter: { bundle_id: "b1" },
    });
    expect(index.query.mock.calls[1][1].filter).toEqual({ bundle_id: { $in: ["b1", "b2"] } });
  });

  it("splits a long bundle list and keeps the best across the answers", async () => {
    const index = fakeIndex();
    index.query
      .mockResolvedValueOnce({
        matches: [
          { id: "a", score: 0.5 },
          { id: "b", score: 0.2 },
        ],
      })
      .mockResolvedValueOnce({ matches: [{ id: "c", score: 0.9 }] });
    const bundles = Array.from({ length: 50 }, (_, i) => `b${i}`);

    const near = await nearestPassages(index as never, [1], bundles, 2);

    expect(index.query).toHaveBeenCalledTimes(2);
    expect(index.query.mock.calls[0][1].filter.bundle_id.$in).toHaveLength(40);
    expect(near).toEqual([
      { id: "c", similarity: 0.9 },
      { id: "a", similarity: 0.5 },
    ]);
  });
});

describe("syncPassageVectors", () => {
  it("does nothing at all without an index", async () => {
    expect(await syncPassageVectors(env)).toBe(false);
  });

  it("is idle at two reads when nothing changed and the column is empty", async () => {
    const index = fakeIndex();
    const { client } = fakeService({});
    service.current = client;

    expect(await syncPassageVectors({ ...env, PASSAGES: index as never })).toBe(false);
    expect(index.upsert).not.toHaveBeenCalled();
    expect(index.deleteByIds).not.toHaveBeenCalled();
  });

  it("deletes what was deleted, re-files what moved, and clears what it told", async () => {
    const index = fakeIndex();
    index.getByIds.mockResolvedValue([
      { id: "moved", values: [0.1, 0.2], metadata: { bundle_id: "old", workspace_id: "w" } },
    ]);
    const { client, cleared } = fakeService({
      changes: [
        { id: 1, chunk_id: "gone", bundle_id: null, document_id: null },
        { id: 2, chunk_id: "moved", bundle_id: "new", document_id: "d" },
        // Moved, then deleted: deleted.
        { id: 3, chunk_id: "both", bundle_id: "new", document_id: "d" },
        { id: 4, chunk_id: "both", bundle_id: null, document_id: null },
      ],
    });
    service.current = client;

    expect(await syncPassageVectors({ ...env, PASSAGES: index as never })).toBe(true);

    expect(index.deleteByIds).toHaveBeenCalledWith(["gone", "both"]);
    expect(index.getByIds).toHaveBeenCalledWith(["moved"]);
    expect(index.upsert).toHaveBeenCalledWith([
      {
        id: "moved",
        values: [0.1, 0.2],
        metadata: { bundle_id: "new", document_id: "d", workspace_id: "w" },
      },
    ]);
    expect(cleared).toEqual([{ table: "passage_vector_changes", filter: 4 }]);
  });

  it("moves embeddings out of the column into the index, then clears them", async () => {
    const index = fakeIndex();
    const { client, nulled } = fakeService({
      inline: [
        [
          {
            id: "c1",
            workspace_id: "w",
            bundle_id: "b",
            document_id: "d",
            embedding: "[0.5,0.25]",
          },
        ],
      ],
    });
    service.current = client;

    expect(await syncPassageVectors({ ...env, PASSAGES: index as never })).toBe(true);

    expect(index.upsert).toHaveBeenCalledWith([
      {
        id: "c1",
        values: [0.5, 0.25],
        metadata: { bundle_id: "b", document_id: "d", workspace_id: "w" },
      },
    ]);
    expect(nulled).toEqual([["c1"]]);
  });

  it("leaves the column alone when the index refuses the vectors", async () => {
    const index = fakeIndex();
    index.upsert.mockRejectedValue(new Error("index down"));
    const { client, nulled } = fakeService({
      inline: [[{ id: "c1", workspace_id: "w", bundle_id: "b", document_id: "d", embedding: [1] }]],
    });
    service.current = client;

    // Logged, not thrown: the tick's later stages still run.
    expect(await syncPassageVectors({ ...env, PASSAGES: index as never })).toBe(false);
    expect(nulled).toEqual([]);
  });
});
