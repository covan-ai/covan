// worker/src/cron.ts
import type { RoutineEnv } from "./types";
import { runScheduledWork } from "./lib/background";
import { unfitToServe } from "./lib/env";

/**
 * The routine engine as a Worker of its own — no API, no HTTP handler at all.
 *
 * Why this exists rather than the cron living on the API Worker (src/index.ts,
 * which still exports a `scheduled` handler): Cloudflare caps a Free account at
 * five cron triggers, and the account hosting the API is already at that cap.
 * This Worker is deployed to a second account (`wrangler.cron.toml`) purely to
 * get a sixth trigger, which means the API Worker, its workers.dev URL, and the
 * R2 bucket holding every uploaded document all stay exactly where they are —
 * nothing migrates, and the frontend never learns this happened.
 *
 * Both Workers talk to the same Supabase project, so in principle both could
 * tick. That is safe by construction: `claim_due_routines` hands out rows with
 * `for update skip locked`, so two ticks can never claim the same routine.
 *
 * Deliberately no `fetch` handler and `workers_dev = false`: this Worker has no
 * business being reachable over the internet. Verify a deploy through
 * `wrangler tail` and the routine_runs table, not by curling it.
 */
export default {
  scheduled(_event: ScheduledEvent, env: RoutineEnv, ctx: ExecutionContext) {
    // The API Worker's check (`index.ts`), for the engine: a deploy configured
    // from `.env.docker.example` runs nothing. Thrown, so the tick is recorded
    // as failed rather than as a quiet success.
    const problem = unfitToServe(env as unknown as Record<string, unknown>);
    if (problem) throw new Error(`Refusing to run: ${problem}`);
    ctx.waitUntil(
      // Log and re-throw. Swallowing the error would have Cloudflare record a
      // broken tick as a successful invocation, so the engine could be dead for
      // days with a green dashboard.
      runScheduledWork(env).catch((err) => {
        console.error("scheduled tick failed", err);
        throw err;
      }),
    );
  },
};
