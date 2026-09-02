import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { defaultHorizon, purgeExpired } from "./purge";
import type { DocStore } from "./docstore";

/**
 * A hand-rolled stub rather than `test-support/fake-db`, which is the call that
 * file's own docstring asks for: the sweep touches three tables in two shapes
 * (`select().lt()` and `delete().in()`), and the strict fake models neither
 * `.lt()` nor the ordering this test exists to assert.
 *
 * Every call is appended to `log`, in order. That is the assertion — the sweep
 * is correct or incorrect entirely by the sequence it performs, because after
 * the rows are gone nothing can enumerate the keys they named.
 */
function stubDb(rows: Record<string, Record<string, unknown>[]>) {
  const log: string[] = [];

  const db = {
    from(table: string) {
      return {
        select(columns: string) {
          return {
            lt(column: string, _value: string) {
              log.push(`select ${table}.${columns} where ${column} < cutoff`);
              return Promise.resolve({ data: rows[table] ?? [], error: null });
            },
            in(column: string, values: string[]) {
              log.push(`select ${table}.${columns} where ${column} in (${values.length})`);
              return Promise.resolve({ data: rows[`${table}:in`] ?? [], error: null });
            },
          };
        },
        delete() {
          return {
            in(column: string, values: string[]) {
              log.push(`delete ${table} where ${column} in (${values.length})`);
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  return { db, log };
}

function stubStore(log: string[], failOn: string[] = []): DocStore {
  return {
    get: async () => null,
    put: async () => {},
    delete: async (key: string) => {
      log.push(`store delete ${key}`);
      if (failOn.includes(key)) throw new Error("bucket said no");
    },
  } as unknown as DocStore;
}

const HORIZON = new Date("2026-08-03T00:00:00.000Z");

describe("the thirty-day sweeper", () => {
  it("collects every key before it deletes a single row", async () => {
    const { db, log } = stubDb({
      knowledge_bundles: [{ id: "bundle-1" }],
      agents: [{ id: "agent-1" }],
      documents: [{ id: "doc-1", r2_key: "keys/one.pdf" }],
      // Documents that live inside the expiring bundle. They will be taken by
      // the cascade whether or not they were marked, so their keys have to be
      // collected too — this is the population a naive sweep misses, and the
      // one whose files are then orphaned forever.
      "documents:in": [{ r2_key: "keys/two.pdf" }],
    });

    await purgeExpired({ db, store: stubStore(log), horizon: HORIZON });

    const firstDelete = log.findIndex((l) => l.startsWith("delete "));
    const lastSelect = log.map((l) => l.startsWith("select ")).lastIndexOf(true);

    expect(firstDelete).toBeGreaterThan(-1);
    expect(lastSelect).toBeLessThan(firstDelete);
  });

  it("deletes the stored objects only after the rows that named them", async () => {
    const { db, log } = stubDb({
      knowledge_bundles: [{ id: "bundle-1" }],
      agents: [],
      documents: [{ id: "doc-1", r2_key: "keys/one.pdf" }],
      "documents:in": [{ r2_key: "keys/two.pdf" }],
    });

    await purgeExpired({ db, store: stubStore(log), horizon: HORIZON });

    const lastRowDelete = log.map((l) => l.startsWith("delete ")).lastIndexOf(true);
    const firstObjectDelete = log.findIndex((l) => l.startsWith("store delete "));

    expect(firstObjectDelete).toBeGreaterThan(lastRowDelete);
    expect(log.filter((l) => l.startsWith("store delete "))).toEqual([
      "store delete keys/one.pdf",
      "store delete keys/two.pdf",
    ]);
  });

  it("takes a bundle's documents even when only the bundle was marked", async () => {
    const { db, log } = stubDb({
      knowledge_bundles: [{ id: "bundle-1" }],
      agents: [],
      documents: [],
      "documents:in": [{ r2_key: "keys/inside.pdf" }],
    });

    const result = await purgeExpired({ db, store: stubStore(log), horizon: HORIZON });

    expect(result.bundles).toBe(1);
    expect(result.documents).toBe(0);
    expect(log).toContain("store delete keys/inside.pdf");
  });

  it("does nothing at all when nothing has expired", async () => {
    const { db, log } = stubDb({ knowledge_bundles: [], agents: [], documents: [] });

    const result = await purgeExpired({ db, store: stubStore(log), horizon: HORIZON });

    expect(result).toEqual({
      agents: 0,
      bundles: 0,
      documents: 0,
      objects: 0,
      objectFailures: 0,
    });
    expect(log.some((l) => l.startsWith("delete "))).toBe(false);
    expect(log.some((l) => l.startsWith("store delete "))).toBe(false);
  });

  it("counts a failed object delete instead of abandoning the rest", async () => {
    // The one failure in the sweep nothing downstream can repair: the rows that
    // knew the key are already gone, so a throw here would strand every key
    // after it as well.
    const { db, log } = stubDb({
      knowledge_bundles: [],
      agents: [],
      documents: [
        { id: "doc-1", r2_key: "keys/bad.pdf" },
        { id: "doc-2", r2_key: "keys/good.pdf" },
      ],
    });

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await purgeExpired({
      db,
      store: stubStore(log, ["keys/bad.pdf"]),
      horizon: HORIZON,
    });
    errors.mockRestore();

    expect(result.objectFailures).toBe(1);
    expect(result.objects).toBe(1);
    expect(log).toContain("store delete keys/good.pdf");
  });

  it("still removes the rows when no store is configured", async () => {
    const { db, log } = stubDb({
      knowledge_bundles: [],
      agents: [{ id: "agent-1" }],
      documents: [],
    });

    const result = await purgeExpired({ db, store: null, horizon: HORIZON });

    expect(result.agents).toBe(1);
    expect(result.objects).toBe(0);
    expect(log.some((l) => l.startsWith("store delete "))).toBe(false);
  });
});

describe("the horizon", () => {
  it("is thirty days behind, so today's deletion survives today", () => {
    const now = new Date("2026-09-02T12:00:00.000Z");
    expect(defaultHorizon(now).toISOString()).toBe("2026-08-03T12:00:00.000Z");
  });
});
