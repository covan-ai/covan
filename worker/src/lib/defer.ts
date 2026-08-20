import type { Context } from "hono";

/**
 * Run work past the end of the response.
 *
 * On Cloudflare, `waitUntil` keeps the isolate alive until the promise settles;
 * without it the runtime may cancel the work as soon as the response is sent.
 * On Node there is no execution context — accessing `c.executionCtx` throws —
 * and none is needed, because the process outlives the request anyway.
 *
 * Rejections are logged rather than propagated: the response has already been
 * sent, so there is nobody left to tell.
 */
export function deferred(c: Context, promise: Promise<unknown>): void {
  const logged = promise.catch((err) => {
    console.error("deferred task failed", err);
  });

  try {
    c.executionCtx.waitUntil(logged);
  } catch {
    void logged;
  }
}
