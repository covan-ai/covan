import { serve } from "@hono/node-server";
import { app } from "./index";
import { loadEnv } from "./lib/env";
import { runScheduledWork } from "./lib/background";

/**
 * The self-hosted entry point.
 *
 * Cloudflare gives the Worker its bindings and fires `scheduled` from a cron
 * trigger. Neither exists here, so this file supplies both: bindings come from
 * the process environment, and the background work runs on an interval.
 *
 * The tick is unchanged from Cloudflare's — `lib/background` decides what one
 * does, so a self-hosted stack syncs its connected sources on exactly the same
 * terms as the hosted one. It has `DOCS_DIR`, so `canSyncConnections` is
 * satisfied and there is nothing extra to configure.
 *
 * Overlap is safe: both `claim_due_routines` and `claim_due_connections` hand
 * out rows with `for update skip locked`, so a slow tick meeting the next one
 * cannot run the same work twice.
 */
const env = loadEnv();
const port = Number(process.env.PORT ?? 8787);
const tickMs = Number(process.env.ROUTINE_TICK_MS ?? 60_000);

const server = serve({ fetch: (request: Request) => app.fetch(request, env), port }, (info) => {
  console.log(`covan-api listening on http://localhost:${info.port}`);
});

const tick = setInterval(() => {
  runScheduledWork(env).catch((err) => console.error("scheduled tick failed", err));
}, tickMs);

/**
 * Shut down on a signal instead of waiting to be killed.
 *
 * In a container this process is PID 1, or the child of an init that forwards
 * to it. The kernel gives PID 1 no default signal disposition, so a program
 * that relies on the default is immune to SIGTERM and `docker stop` degenerates
 * into a ten-second wait and a SIGKILL. Bun and Node both install their own
 * SIGTERM handling and do exit (measured: ~1.2s as bare PID 1), so this handler
 * is not what rescues the stop — what it buys is a *deliberate* shutdown:
 * stop claiming routines, then close the listener, instead of being terminated
 * mid-tick. Measured with docker/compose's tini in front: ~0.25s.
 *
 * The interval is cleared first so a tick cannot start while the server is
 * closing. `claim_due_routines` uses `for update skip locked`, so a routine
 * already claimed by a tick that dies here is picked up by the next process
 * once its claim expires — nothing is lost, it is only late.
 */
const shutdown = (signal: NodeJS.Signals) => {
  console.log(`${signal} received, shutting down`);
  clearInterval(tick);
  server.close(() => process.exit(0));
  // Long-lived responses (the SSE chat stream) hold sockets open, and
  // server.close() waits for every one of them. Give them a moment, then go
  // anyway — still well inside docker's grace period. `unref` so this timer is
  // not itself a reason for the process to stay alive.
  setTimeout(() => process.exit(0), 3_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
