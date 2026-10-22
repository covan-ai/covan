import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

/**
 * Every response says which request it answered.
 *
 * The error page (A31) shows a short id beside "Something went wrong on this
 * page", with Copy, so a report can be matched to the log line it came from.
 * Cloudflare already names each request (`cf-ray`), and that is the id worth
 * quoting there because it is what the dashboard searches by; on Node there is
 * none, so one is minted.
 *
 * `X-Request-Id` goes on every response and is exposed to the page through
 * CORS (`index.ts`). A 5xx with a JSON body also carries it as `requestId`,
 * which is where `request()` in src/lib/api-client.ts reads it from when the
 * header is not readable. Mounted ahead of the limiter, so a 429 has one too.
 */
export function requestIdFor(header: string | undefined): string {
  const ray = header?.trim();
  return ray && /^[A-Za-z0-9-]{8,64}$/.test(ray) ? ray : crypto.randomUUID();
}

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = requestIdFor(c.req.header("cf-ray"));
  c.set("requestId", id);
  await next();

  try {
    c.res.headers.set("X-Request-Id", id);
  } catch {
    // A response passed through from `fetch` (the logo proxy) has immutable
    // headers on Workers; a copy of it does not.
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set("X-Request-Id", id);
  }
  if (c.res.status < 500) return;
  if (!(c.res.headers.get("Content-Type") ?? "").includes("application/json")) return;

  // A body that is not an object (or not JSON after all) is left alone; the
  // header still names the request.
  const body = await c.res
    .clone()
    .json()
    .catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const headers = new Headers(c.res.headers);
  headers.delete("Content-Length");
  c.res = new Response(JSON.stringify({ ...body, requestId: id }), {
    status: c.res.status,
    headers,
  });
};
