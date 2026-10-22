import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { trackTurn } from "./active-turns";

function fakeService(fail = false) {
  const writes: Array<{ op: string; values?: unknown; filter?: unknown }> = [];
  const db = {
    from(table: string) {
      expect(table).toBe("active_turns");
      const done = async () => ({ error: fail ? { message: "down" } : null });
      return {
        upsert(values: unknown) {
          writes.push({ op: "upsert", values });
          return done();
        },
        update(values: unknown) {
          return {
            eq(_c: string, v: unknown) {
              writes.push({ op: "update", values, filter: v });
              return done();
            },
          };
        },
        delete() {
          return {
            eq(_c: string, v: unknown) {
              writes.push({ op: "delete", filter: v });
              return done();
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as SupabaseClient, writes };
}

const ROW = { sessionId: "s1", workspaceId: "w1", agentId: "a1", userId: "u1" };

describe("trackTurn", () => {
  it("starts, moves along with each step, and ends, in that order", async () => {
    const { db, writes } = fakeService();
    const turn = trackTurn(db, ROW);
    await turn.start();
    turn.step({ index: 0, tool: "read_pages", status: "running", label: "Reading 6 pages" });
    turn.step({ index: 0, tool: "read_pages", status: "ok", label: "Read 6 pages" });
    await turn.end();

    expect(writes.map((w) => w.op)).toEqual(["upsert", "update", "update", "delete"]);
    expect(writes[0]!.values).toMatchObject({ session_id: "s1", steps_done: 0, user_id: "u1" });
    expect(writes[1]!.values).toMatchObject({ last_tool: "read_pages", note: "Reading 6 pages" });
    expect(writes[2]!.values).toMatchObject({ steps_done: 1 });
    expect(writes[3]!.filter).toBe("s1");
  });

  it("writes nothing after the turn ended, so a late step cannot bring the row back", async () => {
    const { db, writes } = fakeService();
    const turn = trackTurn(db, ROW);
    await turn.start();
    await turn.end();
    turn.step({ index: 1, tool: "browse", status: "running", label: "Opening a page" });
    await turn.end();
    expect(writes.map((w) => w.op)).toEqual(["upsert", "delete"]);
  });

  it("keeps the turn going when a write fails", async () => {
    const { db } = fakeService(true);
    const turn = trackTurn(db, ROW);
    await expect(turn.start()).resolves.toBeUndefined();
    turn.step({ index: 0, tool: "x", status: "running", label: "y".repeat(500) });
    await expect(turn.end()).resolves.toBeUndefined();
  });
});
