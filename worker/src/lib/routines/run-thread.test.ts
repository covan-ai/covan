import { describe, expect, it } from "vitest";
import { RUN_THREADS_KEPT, writeRunThread, type RoutineRow, type RunOutcome } from "./executor";

/**
 * A run as a thread in the Inbox (0123). What it writes, when it writes
 * nothing, and what it keeps.
 */

const ROUTINE: RoutineRow = {
  id: "r1",
  agent_id: "a1",
  user_id: "u1",
  workspace_id: "w1",
  name: "Weekly competitor brief",
  visibility: "shared",
  source_kind: "none",
  source_config: {},
  instruction: "Summarise",
  delivery_channel_id: "c1",
  schedule_cron: "0 9 * * 1",
  timezone: "UTC",
  next_run_at: "2026-10-20T09:00:00.000Z",
  cursor: null,
  consecutive_failures: 0,
  ends_after_runs: null,
  runs_done: 0,
};

function fakeDb(opts: { oldThreads?: string[]; repliedIn?: string[] } = {}) {
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  const deleted: string[] = [];
  const db = {
    from(table: string) {
      return {
        insert(values: Record<string, unknown>) {
          inserts.push({ table, values });
          if (table === "chat_sessions") {
            return {
              select: () => ({ single: async () => ({ data: { id: "s-new" }, error: null }) }),
            };
          }
          return Promise.resolve({ error: null });
        },
        select() {
          const chain: Record<string, unknown> = {
            eq: () => chain,
            order: () => chain,
            range: async () => ({
              data: (opts.oldThreads ?? []).map((id) => ({ id })),
              error: null,
            }),
            in: () => chain,
            then: (resolve: (v: unknown) => unknown) =>
              resolve({
                data: (opts.repliedIn ?? []).map((session_id) => ({ session_id })),
                error: null,
              }),
          };
          return chain;
        },
        delete() {
          return {
            in: async (_c: string, ids: string[]) => {
              deleted.push(...ids);
              return { error: null };
            },
          };
        },
      };
    },
  };
  return { db, inserts, deleted };
}

const deps = (db: unknown) => ({ db }) as never;
const AT = new Date("2026-10-20T09:04:00.000Z");

describe("writeRunThread", () => {
  it("opens a thread with the report as its reply, carrying what the run spent", async () => {
    const { db, inserts } = fakeDb();
    const outcome = {
      status: "ok",
      itemsNew: 1,
      tokens: 120,
      summary: "Three competitors moved on price this week.",
      spend: [
        { kind: "completion", model: "gpt-4.1", promptTokens: 100, completionTokens: 20 },
        { kind: "embedding", model: "text-embedding-3-small", tokens: 9 },
      ],
    } as RunOutcome;

    const id = await writeRunThread(ROUTINE, deps(db), outcome, AT);

    expect(id).toBe("s-new");
    expect(inserts[0]).toEqual({
      table: "chat_sessions",
      values: {
        agent_id: "a1",
        user_id: "u1",
        workspace_id: "w1",
        kind: "routine",
        routine_id: "r1",
        visibility: "shared",
        title: "Weekly competitor brief",
      },
    });
    expect(inserts[1]!.values).toMatchObject({
      session_id: "s-new",
      role: "assistant",
      content: "Three competitors moved on price this week.",
      model: "gpt-4.1",
      prompt_tokens: 100,
      completion_tokens: 20,
      created_at: AT.toISOString(),
    });
  });

  it("says a failed run failed, and why", async () => {
    const { db, inserts } = fakeDb();
    await writeRunThread(
      ROUTINE,
      deps(db),
      { status: "failed", itemsNew: 0, tokens: 0, error: "the feed answered 503" } as RunOutcome,
      AT,
    );
    expect(inserts[1]!.values.content).toBe("This run failed: the feed answered 503");
  });

  it("writes nothing for a skipped run, or for a routine that does not deliver to the Inbox", async () => {
    const skipped = fakeDb();
    expect(
      await writeRunThread(
        ROUTINE,
        deps(skipped.db),
        { status: "skipped", itemsNew: 0, tokens: 0, spend: [] } as RunOutcome,
        AT,
      ),
    ).toBeNull();
    expect(skipped.inserts).toEqual([]);

    const off = fakeDb();
    expect(
      await writeRunThread(
        { ...ROUTINE, deliver_inbox: false },
        deps(off.db),
        { status: "ok", itemsNew: 1, tokens: 1, summary: "x", spend: [] } as RunOutcome,
        AT,
      ),
    ).toBeNull();
    expect(off.inserts).toEqual([]);
  });

  it(`keeps the newest ${RUN_THREADS_KEPT} run threads, and any somebody replied in`, async () => {
    const { db, deleted } = fakeDb({ oldThreads: ["old-1", "old-2"], repliedIn: ["old-2"] });
    await writeRunThread(
      ROUTINE,
      deps(db),
      { status: "ok", itemsNew: 1, tokens: 1, summary: "x", spend: [] } as RunOutcome,
      AT,
    );
    expect(deleted).toEqual(["old-1"]);
  });
});
