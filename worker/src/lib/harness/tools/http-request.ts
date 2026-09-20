import { assertFetchableUrl, ownHostsFrom } from "../../routines/url-guard";
import { readCapped, resolvesPublicly } from "../../routines/source";
import { loadConnection } from "../connections";
import { authHeaders } from "../secrets";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";

/**
 * One implementation of "call an API", for every API.
 *
 * There is no HubSpot tool here and there will not be one. A service is a row
 * in `tool_connections`; this is how every row with `transport = 'http'` is
 * reached. The cost of that generality is that the MODEL decides which
 * endpoint to call, which is a bigger blast radius than a hand-written tool
 * per service — so three things hold it, and none of them is the model
 * behaving well:
 *
 *   1. **The origin is locked.** The model names a path, never a URL, and the
 *      path is re-checked against the connection's own origin after it is
 *      resolved. Leaving the origin is not forbidden, it is impossible.
 *   2. **The methods are a person's decision.** `allowed_methods` is set when
 *      the connection is created and defaults to `GET` alone. The model cannot
 *      widen it and cannot see what it would take to.
 *   3. **Nothing writes by default.** The first connection opened to write
 *      methods is the one that needs 0058's grant screen, and that is written
 *      down in `docs/integrations.md` rather than left as a thing somebody
 *      remembers.
 *
 * Everything below the guard is `lib/routines/source.ts`'s outbound pattern,
 * reused rather than re-derived: the same SSRF guard, the same refusal to
 * follow a redirect, the same capped read.
 */

/** Long enough for a slow API, short enough that a hung one does not hold the turn. */
const TIMEOUT_MS = 15_000;

/** What comes back to the model. The harness caps again; this caps the read itself. */
const MAX_BYTES = 256 * 1024;

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * `base_url` + `path`, or a reason it cannot be.
 *
 * Written defensively three times over, because this is the one function in
 * the file whose mistakes are interesting. `new URL(path, base)` alone is not
 * enough: an absolute URL in `path` replaces the base entirely, and a path
 * beginning `//` replaces the host. Both are checked before resolution and the
 * result is checked again after it, because a `..` segment can climb out of a
 * base path that has one.
 */
export function resolveTarget(
  baseUrl: string,
  path: string,
): { ok: true; url: URL } | { ok: false; message: string } {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return { ok: false, message: "this connection has an unusable base URL" };
  }
  const raw = path.trim();
  if (!raw.startsWith("/")) {
    return { ok: false, message: "path must start with / and must not be a full URL" };
  }
  if (raw.startsWith("//") || raw.includes("://")) {
    return { ok: false, message: "path must be a path on this connection, not another address" };
  }

  // A base of `https://api.example.com/v1` means every path hangs off `/v1`.
  // Without the trailing slash `new URL("/x", base)` would resolve to
  // `https://api.example.com/x` and quietly leave the prefix behind.
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const url = new URL(`${basePath}${raw.slice(1)}`, base);

  if (url.origin !== base.origin) {
    return { ok: false, message: "that path resolves outside this connection" };
  }
  if (!url.pathname.startsWith(basePath) && url.pathname !== basePath.slice(0, -1)) {
    return { ok: false, message: "that path resolves above this connection's base path" };
  }
  return { ok: true, url };
}

export const httpRequestTool: AgentTool = {
  name: "http_request",
  description:
    "Call an HTTP API this workspace has connected. You give the connection id and a path " +
    "on that connection — never a full URL, which is refused. The method must be one the " +
    "team allowed when they set the connection up; GET is usually the only one. Use " +
    "describe_connection first if you do not know what paths exist.",
  input: {
    type: "object",
    properties: {
      connectionId: { type: "string", description: "The id of a connected HTTP API." },
      method: { type: "string", enum: [...METHODS], description: "HTTP method." },
      path: {
        type: "string",
        description: "A path on the connection, starting with /. Not a full URL.",
      },
      query: {
        type: "object",
        description: "Query string parameters, as a flat object of strings.",
        additionalProperties: { type: "string" },
      },
      body: {
        type: "string",
        description: "Request body, already serialised. Ignored for GET and HEAD.",
      },
    },
    required: ["connectionId", "method", "path"],
    additionalProperties: false,
  },
  destructive: true,
  // Configured whenever the guard can be built, which needs the origin list.
  // A deployment with no ALLOWED_ORIGIN cannot refuse a request pointed back
  // at itself, and offering the tool in that state would be offering it
  // broken.
  needs: "connection",
  isConfigured: (env: ToolEnv) => Boolean(env.ALLOWED_ORIGIN),
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = args as {
      connectionId?: unknown;
      method?: unknown;
      path?: unknown;
      query?: unknown;
      body?: unknown;
    };
    if (typeof input.connectionId !== "string" || !input.connectionId) {
      return { kind: "error", message: "connectionId is required" };
    }
    if (typeof input.path !== "string" || !input.path) {
      return { kind: "error", message: "path is required" };
    }
    const method = String(input.method ?? "GET").toUpperCase();
    if (!(METHODS as readonly string[]).includes(method)) {
      return { kind: "error", message: `${method} is not an HTTP method this tool sends` };
    }

    const connection = await loadConnection(ctx, input.connectionId);
    if (!connection) return { kind: "error", message: "no such connection in this workspace" };
    if (connection.transport !== "http") {
      return {
        kind: "error",
        message: `${connection.label} is a database connection — use query_database for it`,
      };
    }
    if (!connection.allowed_methods.includes(method)) {
      // Named rather than generic, because the model's next move should be to
      // stop asking rather than to try another verb.
      return {
        kind: "error",
        message:
          `${method} is not allowed on ${connection.label}. The team allowed: ` +
          `${connection.allowed_methods.join(", ") || "nothing"}. Do not retry with another ` +
          `method — this is a person's decision, not a limit you can work around.`,
      };
    }

    const resolved = resolveTarget(connection.base_url, input.path);
    if (!resolved.ok) return { kind: "error", message: resolved.message };
    const url = resolved.url;

    if (input.query && typeof input.query === "object" && !Array.isArray(input.query)) {
      for (const [key, value] of Object.entries(input.query as Record<string, unknown>)) {
        if (typeof value === "string") url.searchParams.set(key, value);
      }
    }

    // The same two-part guard every outbound fetch in this codebase owes:
    // the hostname string, and — on the runtime that resolves DNS itself —
    // what it resolves to. A connection's base URL was checked when it was
    // created; DNS is not a promise, and the check that catches a host that
    // has since become `169.254.169.254` is the one at call time.
    let target: URL;
    try {
      target = assertFetchableUrl(url.toString(), ownHostsFrom(ctx.env));
      await resolvesPublicly(target.hostname);
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : "unsafe url" };
    }

    const headers: Record<string, string> = {
      Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      "User-Agent": "covan-agent/1.0",
      ...(await authHeaders(ctx.env, connection)),
    };
    const sendsBody = method !== "GET" && method !== "HEAD" && typeof input.body === "string";
    if (sendsBody) headers["Content-Type"] = "application/json";

    const res = await fetch(target.toString(), {
      method,
      headers,
      ...(sendsBody ? { body: input.body as string } : {}),
      // Every 3xx is an error, for `lib/routines/delivery.ts`'s reason: a
      // redirect is either a request to repeat a credentialed request at a
      // host the connection does not name, or a request to drop the body.
      // Neither is the call that was authorised.
      redirect: "manual",
      signal: ctx.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.status >= 300 && res.status < 400) {
      return {
        kind: "error",
        message:
          `${res.status} redirect to ${res.headers.get("Location") ?? "(no Location)"} — ` +
          "not followed. The connection should be pointed at the final address.",
      };
    }

    // An endpoint that answers with more than the cap is a failed call, not
    // a failed turn: the model is told the response was too large and can ask
    // for less. `readCapped` cancels the stream at the ceiling rather than
    // reading to the end and slicing, which on this runtime is the difference
    // between a cap and no cap at all.
    let text: string;
    try {
      text = await readCapped(res, MAX_BYTES);
    } catch (err) {
      return {
        kind: "error",
        message: err instanceof Error ? err.message : "could not read the response",
      };
    }

    if (!res.ok) {
      // The body is returned on a failure as well as a success, and that is
      // the useful half: an API that says "unknown field `emial`" tells the
      // model how to fix its next call, where "400 Bad Request" tells it
      // nothing and it tries the same thing again.
      return {
        kind: "error",
        message: `${res.status} ${res.statusText}${text ? `\n${text.slice(0, 2000)}` : ""}`,
      };
    }

    return { kind: "ok", content: text || "(empty response)" };
  },
};
