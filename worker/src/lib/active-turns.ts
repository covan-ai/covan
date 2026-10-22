import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A running turn, told to everybody who can see its thread (0122).
 *
 * The tab that started a turn watches it stream; nobody else could, so the
 * sidebar, the Inbox, the Threads table and Home had no way to say "Research
 * is running, step 3, reading 6 pages". This writes that sentence where they
 * can read it: one `active_turns` row per thread, upserted when the turn
 * starts, moved along as each step starts and settles, and deleted when the
 * turn ends however it ends.
 *
 * Best-effort, every write. A turn that cannot say it is running still runs;
 * a row left behind by a turn that died is older than thirty minutes within
 * thirty minutes, which every reader ignores and the purge sweeps.
 *
 * The writes are queued, one after another, and `end` waits for the queue: a
 * step that settles after the turn ended must not resurrect the row, and on
 * Workers an un-awaited write is cut off when the response finishes.
 *
 * With the service role — the table has no client write policy, for the
 * reason `paused_turns` has none — and only ever for the thread the caller's
 * request already opened.
 */
export type TurnStepEvent = { index: number; tool: string; status: string; label: string };

export type ActiveTurn = {
  start(): Promise<void>;
  step(event: TurnStepEvent): void;
  end(): Promise<void>;
};

export const ACTIVE_TURN_NOTE_MAX = 200;

export function trackTurn(
  service: SupabaseClient,
  row: { sessionId: string; workspaceId: string; agentId: string; userId: string | null },
): ActiveTurn {
  let queue: Promise<void> = Promise.resolve();
  let ended = false;
  const write = (label: string, op: () => PromiseLike<{ error: unknown }>) => {
    queue = queue.then(async () => {
      try {
        const { error } = await op();
        if (error) console.error(`active turn: could not ${label}`, error);
      } catch (err) {
        console.error(`active turn: could not ${label}`, err);
      }
    });
  };

  return {
    async start() {
      const now = new Date().toISOString();
      write("start", () =>
        service.from("active_turns").upsert(
          {
            session_id: row.sessionId,
            workspace_id: row.workspaceId,
            agent_id: row.agentId,
            user_id: row.userId,
            started_at: now,
            steps_done: 0,
            last_tool: null,
            note: null,
            updated_at: now,
          },
          { onConflict: "session_id" },
        ),
      );
      await queue;
    },
    step(event) {
      if (ended) return;
      const patch =
        event.status === "running"
          ? { last_tool: event.tool, note: event.label.slice(0, ACTIVE_TURN_NOTE_MAX) }
          : { steps_done: event.index + 1 };
      write("move along", () =>
        service
          .from("active_turns")
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq("session_id", row.sessionId),
      );
    },
    async end() {
      if (ended) return;
      ended = true;
      write("end", () => service.from("active_turns").delete().eq("session_id", row.sessionId));
      await queue;
    },
  };
}
