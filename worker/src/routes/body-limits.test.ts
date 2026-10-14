import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { slackPublic } from "./slack";
import { bundles } from "./bundles";
import { avatars } from "./avatars";
import { transcribe } from "./transcribe";

/**
 * Bodies a client streams without saying how big they are.
 *
 * Every route here already refused an oversized upload by its Content-Length.
 * A chunked body has none, so each one read the whole stream before finding
 * out — and `/slack/events`, which needs no session at all, read it whole
 * before checking the signature. On the Node entry three 200 MB streams took
 * the process past 1.8 GB. Each case below streams just past its limit, with
 * no Content-Length, and expects a 413 before anything else is touched.
 */

const untouchable = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`an oversized request touched the database (${String(property)})`);
    },
  },
);

function app() {
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: "user-1", email: "owner@example.com" } as never);
    c.set("db", untouchable as never);
    await next();
  });
  for (const router of [slackPublic, bundles, avatars, transcribe]) app.route("/", router);
  return app;
}

/** `bytes` of body in 64 KB chunks, with no Content-Length. */
function streamed(path: string, method: string, bytes: number): Request {
  let sent = 0;
  const chunk = new Uint8Array(64 * 1024);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) return controller.close();
      sent += chunk.length;
      controller.enqueue(chunk);
    },
  });
  return new Request(`http://api.test${path}`, {
    method,
    body,
    headers: { "Content-Type": "multipart/form-data; boundary=x" },
    duplex: "half",
  } as RequestInit);
}

const MB = 1024 * 1024;

describe("a body streamed past its route's limit", () => {
  it.each([
    ["/slack/events", "POST", 2 * MB],
    ["/bundles/b1/documents/upload", "POST", 21 * MB],
    ["/me/avatar", "PUT", 3 * MB],
    ["/transcribe", "POST", 3 * MB],
  ])("is refused at %s without being read whole", async (path, method, bytes) => {
    const request = streamed(path, method, bytes);
    expect(request.headers.get("content-length")).toBeNull();

    const res = await app().fetch(request, { SLACK_SIGNING_SECRET: "s" } as never);

    expect(res.status).toBe(413);
  });
});
