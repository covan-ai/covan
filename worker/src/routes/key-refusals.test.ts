import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { connections } from "./connections";
import { composio } from "./composio";
import { slack } from "./slack";
import { toolConnections } from "./tool-connections";
import { workspace } from "./workspace";
import { invitations } from "./invitations";
import { routines } from "./routines";

/**
 * The handlers that must refuse an API key, each asked the
 * way a script would ask it.
 *
 * `api-key-refusal.static.test.ts` proves each handler contains the refusal.
 * This proves the refusal comes FIRST: the database below throws on any use,
 * so a handler that read or wrote anything before refusing — started the OAuth
 * state, looked up the connection, wrote a grant — fails here rather than
 * answering 403 after the damage.
 */

const ID = "00000000-0000-4000-8000-000000000001";

const untouchable = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`a refused request touched the database (${String(property)})`);
    },
  },
);

function app() {
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: "user-1", email: "owner@example.com" } as never);
    c.set("db", untouchable as never);
    c.set("apiKeyId", "key-1");
    await next();
  });
  for (const router of [
    connections,
    composio,
    slack,
    toolConnections,
    workspace,
    invitations,
    routines,
  ]) {
    app.route("/", router);
  }
  return app;
}

const REFUSED: Array<[method: string, path: string, body?: unknown]> = [
  ["POST", "/connections/notion/start", { bundleId: ID }],
  ["POST", "/connections/complete", { grant: "g", nonce: "n".repeat(16) }],
  ["POST", "/slack/complete", { grant: "g", nonce: "n".repeat(16) }],
  ["POST", "/composio/complete", { nonce: "n".repeat(16) }],
  ["POST", `/connections/${ID}/reconnect`],
  ["GET", `/connections/${ID}/folders`],
  ["PATCH", `/connections/${ID}`, { folderId: "folder-1" }],
  ["DELETE", `/connections/${ID}`],
  ["POST", "/composio/connect", { toolkit: "gmail" }],
  ["GET", `/composio/connections/${ID}/status`],
  ["PUT", "/composio/grants", { agentId: ID }],
  ["DELETE", `/composio/grants?agentId=${ID}`],
  ["POST", "/slack/install/start"],
  ["PATCH", "/slack/installation", { agentId: ID }],
  ["DELETE", "/slack/installation"],
  ["POST", "/tool-connections", { name: "x" }],
  ["PATCH", `/tool-connections/${ID}`, { name: "x" }],
  ["DELETE", `/tool-connections/${ID}`],
  ["POST", "/workspaces", { name: "Elsewhere" }],
  ["POST", "/workspace/active", { workspaceId: ID }],
  ["DELETE", "/workspace/members/me"],
  ["DELETE", `/workspace/members/${ID}`],
  ["DELETE", `/invitations/${ID}`],
  ["POST", `/invitations/${ID}/resend`],
  ["POST", `/invitations/${ID}/accept`],
  ["POST", `/delivery-channels/${ID}/rotate`],
];

describe("a request made with an API key", () => {
  it.each(REFUSED)("is refused before it does anything: %s %s", async (method, path, body) => {
    const res = await app().request(
      path,
      {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      {} as never,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: expect.stringMatching(/^api keys cannot .+ — sign in to do this$/),
    });
  });
});
