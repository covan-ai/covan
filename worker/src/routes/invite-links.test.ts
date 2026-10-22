import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import {
  activeWorkspaceTables,
  fakeDb,
  type FakeDbSpec,
  type QueryContext,
} from "../test-support/fake-db";
import { hashInviteToken } from "../lib/invite-token";

const servicePreview = vi.fn();
vi.mock("../lib/supabase", () => ({
  serviceClient: () => ({ rpc: (...args: unknown[]) => servicePreview(...args) }),
}));

import { inviteLinks, inviteLinkPreview } from "./invite-links";

/**
 * Invite links (0129): who may make one, what the answer carries, and that the
 * token is shown once and stored as its hash.
 */

const USER = { id: "u1", email: "mina@acme.test" };
const WS = "ws-1";
const ROW = {
  id: "l1",
  role: "member",
  created_by: "u1",
  created_at: "2026-10-22T09:00:00Z",
  expires_at: "2026-10-29T09:00:00Z",
  revoked_at: null,
  uses: 0,
};

function appWith(spec: FakeDbSpec = {}, key = false) {
  const fake = fakeDb({
    ...spec,
    tables: { ...activeWorkspaceTables(USER.id, WS), ...spec.tables },
  });
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", fake.db as never);
    if (key) c.set("apiKeyId", "key-1");
    await next();
  });
  app.route("/", inviteLinks);
  app.route("/", inviteLinkPreview);
  return { app, ...fake };
}

const post = (app: Hono<AppEnv>, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /invite-links", () => {
  it("mints a token, stores its hash, and hands the URL back once", async () => {
    const { app, callsTo } = appWith({
      tables: { invite_links: { insert: () => ({ data: ROW, error: null }) } },
    });
    const res = await post(app, "/invite-links", { role: "viewer" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { url: string; expiresAt: number };
    const token = decodeURIComponent(body.url.split("#link=")[1]!);
    const written = callsTo("invite_links")[0]!.values!;
    expect(written).toMatchObject({ workspace_id: WS, role: "viewer", created_by: "u1" });
    expect(written.token_hash).toBe(await hashInviteToken(token));
    expect(JSON.stringify(written)).not.toContain(token);
    expect(body.expiresAt).toBe(Date.parse("2026-10-29T09:00:00Z"));
  });

  it("refuses a member, an admin role and a key", async () => {
    const member = appWith({
      tables: {
        invite_links: { insert: () => ({ data: null, error: { code: "42501", message: "rls" } }) },
      },
    });
    expect((await post(member.app, "/invite-links", {})).status).toBe(403);
    expect((await post(member.app, "/invite-links", { role: "admin" })).status).toBe(400);
    const keyed = appWith({}, true);
    expect((await post(keyed.app, "/invite-links", {})).status).toBe(403);
  });
});

describe("GET and DELETE /invite-links", () => {
  it("lists the links still working, and turns one off", async () => {
    const { app, callsTo } = appWith({
      tables: {
        invite_links: {
          select: () => ({ data: [ROW], error: null }),
          update: (ctx: QueryContext) => ({
            data: ctx.filters.some((f) => f.value === "l1") ? [{ id: "l1" }] : [],
            error: null,
          }),
        },
      },
    });
    const list = (await (await app.request("/invite-links")).json()) as Array<{ id: string }>;
    expect(list.map((l) => l.id)).toEqual(["l1"]);
    expect(callsTo("invite_links")[0]!.filters).toEqual(
      expect.arrayContaining([
        { column: "workspace_id", value: WS, kind: "eq" },
        { column: "revoked_at", value: null, kind: "is" },
      ]),
    );
    expect((await app.request("/invite-links/l1", { method: "DELETE" })).status).toBe(200);
    expect((await app.request("/invite-links/l9", { method: "DELETE" })).status).toBe(404);
  });
});

describe("joining with a link", () => {
  it("joins through the function, and says why a dead link does not work", async () => {
    const ok = appWith({ rpc: { accept_invite_link: () => ({ data: WS, error: null }) } });
    expect(await (await post(ok.app, "/invite-links/accept", { token: "t" })).json()).toEqual({
      workspaceId: WS,
    });
    const dead = appWith({
      rpc: {
        accept_invite_link: () => ({
          data: null,
          error: { code: "P0002", message: "this link has expired or was turned off" },
        }),
      },
    });
    const res = await post(dead.app, "/invite-links/accept", { token: "t" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "this link has expired or was turned off" });
  });

  it("shows what the link is to before sign-in, and nothing for a token it does not know", async () => {
    servicePreview.mockResolvedValueOnce({
      data: [
        {
          workspace_name: "Acme",
          inviter_name: "Mina",
          role: "member",
          member_count: 6,
          agent_count: 4,
          expires_at: "2026-10-29T09:00:00Z",
          open: true,
        },
      ],
      error: null,
    });
    const { app } = appWith();
    const res = await post(app, "/invite-links/preview", { token: "t" });
    expect(await res.json()).toEqual({
      workspaceName: "Acme",
      inviterName: "Mina",
      role: "member",
      memberCount: 6,
      agentCount: 4,
      expiresAt: Date.parse("2026-10-29T09:00:00Z"),
      open: true,
    });
    servicePreview.mockResolvedValueOnce({ data: [], error: null });
    expect((await post(app, "/invite-links/preview", { token: "nope" })).status).toBe(404);
  });
});
