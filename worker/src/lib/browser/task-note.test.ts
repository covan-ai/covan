import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { browserTaskNote } from "./task-note";

/**
 * What the chat model is told about this conversation's browser tasks.
 *
 * 2026-10-11: with nothing but its own past sentences to go on, it said three
 * tasks were running when one was.
 */

const NOW = new Date("2026-10-11T16:00:00.000Z");

/** The read, recorded; `rows` newest first, the way the query orders them. */
function dbWith(rows: Array<Record<string, unknown>> | Error) {
  const seen: Record<string, unknown> = {};
  const chain = {
    select: (columns: string) => {
      seen.columns = columns;
      return chain;
    },
    eq: (column: string, value: unknown) => {
      seen[`eq:${column}`] = value;
      return chain;
    },
    gt: (column: string, value: unknown) => {
      seen[`gt:${column}`] = value;
      return chain;
    },
    order: (column: string, opts: { ascending: boolean }) => {
      seen.order = `${column} ${opts.ascending ? "asc" : "desc"}`;
      return chain;
    },
    limit: async (n: number) => {
      seen.limit = n;
      return rows instanceof Error
        ? { data: null, error: { message: rows.message, code: "57014" } }
        : { data: rows, error: null };
    },
  };
  const db = {
    from: (table: string) => {
      seen.table = table;
      return chain;
    },
  } as unknown as SupabaseClient;
  return { db, seen };
}

describe("browserTaskNote", () => {
  it("is null for a conversation with no task in the last day", async () => {
    const { db } = dbWith([]);
    expect(await browserTaskNote(db, "sess-1", NOW)).toBeNull();
  });

  it("reads this conversation's last five from the last day, newest first", async () => {
    const { db, seen } = dbWith([]);
    await browserTaskNote(db, "sess-1", NOW);
    expect(seen).toMatchObject({
      table: "browser_tasks",
      "eq:session_id": "sess-1",
      "gt:created_at": "2026-10-10T16:00:00.000Z",
      order: "created_at desc",
      limit: 5,
    });
    // Nothing the person cannot read: 0073's columns and 0078's two.
    expect(seen.columns).toBe("task, status, error, stop_reason, signin_host, created_at");
  });

  it("lists them oldest first, each with where it stands", async () => {
    const { db } = dbWith([
      { task: "Review tasklet.ai", status: "running" },
      { task: "Review covan.app", status: "finished" },
      { task: "Review the GitHub repo", status: "failed", error: "the page did not load" },
    ]);
    const note = String(await browserTaskNote(db, "sess-1", NOW));
    const lines = note.split("\n");
    expect(lines[1]).toBe('1. "Review the GitHub repo" — failed: the page did not load');
    expect(lines[2]).toBe(
      '2. "Review covan.app" — finished — its answer is already a message in this conversation',
    );
    expect(lines[3]).toBe(
      '3. "Review tasklet.ai" — running now — its answer will arrive as a new message',
    );
    expect(note).toContain("answer from this list and nothing else");
  });

  it("calls a task the provider accepted running, which is what `queued` means", async () => {
    const { db } = dbWith([{ task: "x", status: "queued" }]);
    expect(await browserTaskNote(db, "sess-1", NOW)).toContain("running now");
  });

  it("says a login wall waits on the person, and names the site", async () => {
    const { db } = dbWith([
      { task: "x", status: "failed", stop_reason: "login_required", signin_host: "linkedin.com" },
    ]);
    expect(await browserTaskNote(db, "sess-1", NOW)).toContain(
      "stopped at a sign-in on linkedin.com; waiting for the person to sign in in the browser panel",
    );
  });

  it("says why a task stopped short when the row says", async () => {
    const { db } = dbWith([
      { task: "a", status: "stopped", stop_reason: "handed_to_person" },
      { task: "b", status: "stopped", stop_reason: "cancelled" },
      { task: "c", status: "failed", stop_reason: "cost_cap" },
    ]);
    const note = String(await browserTaskNote(db, "sess-1", NOW));
    expect(note).toContain('"c" — stopped at its cost limit');
    expect(note).toContain('"b" — cancelled');
    expect(note).toContain('"a" — handed to the person in the browser panel');
  });

  it("shortens a long task to one line", async () => {
    const { db } = dbWith([{ task: `Open the page\nand ${"x".repeat(300)}`, status: "running" }]);
    const line = String(await browserTaskNote(db, "sess-1", NOW)).split("\n")[1];
    expect(line).not.toContain("\nand");
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(200);
  });

  it("is null, and does not throw, when the read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = dbWith(new Error("timeout"));
    expect(await browserTaskNote(db, "sess-1", NOW)).toBeNull();
    warn.mockRestore();
  });
});
