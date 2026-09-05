import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type QueryContext } from "../test-support/fake-db";
import { support } from "./support";

/**
 * `lib/email` and `lib/keys/store` are mocked at the module boundary, the same
 * way `provider-keys.test.ts` mocks `lib/keys/store`: `sendEmail` is a real
 * network call to Resend and `readKeyHints` goes through `service_role`
 * directly, so neither has a request-scoped path the fake db could intercept.
 * `lib/ratelimit` is mocked too, so "is rate limited" can force a refusal
 * without needing a real counter.
 *
 * Everything else — the workspace lookup, the member count, the quota
 * snapshot — goes through the real `getActiveWorkspaceId` helper against the
 * fake db and a fake `entitlements`, because that is the part under test: the
 * first case exists to prove the route reads its facts from there and nowhere
 * else.
 */

const sendEmail = vi.fn();
const canSendEmailMock = vi.fn();
vi.mock("../lib/email", () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
  canSendEmail: (...args: unknown[]) => canSendEmailMock(...args),
}));

const readKeyHints = vi.fn();
vi.mock("../lib/keys/store", () => ({
  readKeyHints: (...args: unknown[]) => readKeyHints(...args),
}));

const rateCheck = vi.fn();
vi.mock("../lib/ratelimit", () => ({
  getRateLimiter: () => ({ check: (...args: unknown[]) => rateCheck(...args) }),
}));

const USER = { id: "user-1", email: "real@example.com" };
const WORKSPACE = { id: "ws-1", name: "Real Co", memberCount: 3 };

type RateVerdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

function appWith(opts: {
  send: (...args: unknown[]) => unknown;
  user?: { id: string; email: string };
  workspace?: { id: string; name: string; memberCount: number };
  quota?: { used: number; limit: number };
  supportEmail?: string;
  allowedOrigin?: string;
  rateLimit?: RateVerdict;
}) {
  const user = opts.user ?? USER;
  const workspace = opts.workspace ?? WORKSPACE;
  const quota = opts.quota ?? { used: 10, limit: 1000 };

  canSendEmailMock.mockReturnValue(true);
  readKeyHints.mockResolvedValue({ openai: null, anthropic: null, updatedAt: null });
  rateCheck.mockResolvedValue(opts.rateLimit ?? { allowed: true });
  // `sendEmail` now returns `Promise<Response>` and the route checks `.ok`
  // (it does not throw on a non-2xx — see `lib/email.ts`), so a bare `vi.fn()`
  // passed as `send` — which resolves `undefined` — needs a real ok `Response`
  // standing in for it. A test that wants a specific outcome (a rejection, or
  // a non-ok `Response`) configures `send` itself and that value wins instead.
  sendEmail.mockImplementation(async (...args: unknown[]) => {
    const result = await opts.send(...args);
    return result ?? new Response(null, { status: 200 });
  });

  const fake = fakeDb({
    tables: {
      profiles: {
        // Serves both `getActiveWorkspaceId` (asks for `active_workspace_id`)
        // and the display-name lookup `notifyInvitee` also makes in
        // `routes/invitations.ts` (asks for `name`) — one handler answering
        // both shapes, the same trade `provider-keys.test.ts` makes for
        // `workspace_members` below.
        select: (ctx: QueryContext) =>
          ctx.columns === "name"
            ? { data: { name: null }, error: null }
            : { data: { active_workspace_id: workspace.id }, error: null },
      },
      workspace_members: {
        select: (ctx: QueryContext) => {
          const hasUserFilter = ctx.filters.some((f) => f.column === "user_id");
          if (hasUserFilter) {
            // `getActiveWorkspaceId`'s own membership confirmation.
            const forWorkspace = ctx.filters.some(
              (f) => f.column === "workspace_id" && f.value === workspace.id,
            );
            return forWorkspace
              ? { data: { workspace_id: workspace.id }, error: null }
              : { data: null, error: null };
          }
          // The route's own member count: read as rows, not `head: true`, so
          // the fixture answers with exactly `memberCount` of them.
          return {
            data: Array.from({ length: workspace.memberCount }, (_, i) => ({
              user_id: `member-${i}`,
            })),
            error: null,
          };
        },
      },
      workspaces: {
        select: () => ({ data: { name: workspace.name }, error: null }),
      },
    },
  });

  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", user as never);
    c.set("db", fake.db as never);
    c.set("entitlements", {
      check: async () => ({ allowed: true }) as never,
      record: async () => {},
      snapshot: async () => ({ used: quota.used, limit: quota.limit, resetsAt: null }),
    });
    await next();
  });
  app.route("/", support);

  const env: Record<string, string | undefined> = {
    RESEND_API_KEY: "test-key",
    RESEND_FROM: "Covan <hello@covan.app>",
    SUPPORT_EMAIL: opts.supportEmail,
    ALLOWED_ORIGIN: opts.allowedOrigin ?? "https://app.test",
  };

  return { app, env, ...fake };
}

const post = (app: Hono<AppEnv>, env: Record<string, string | undefined>, body: unknown) =>
  app.request(
    "/support/quota",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /support/quota", () => {
  it("takes its context from the server, not the body", async () => {
    const sent = vi.fn();
    const { app, env } = appWith({
      send: sent,
      user: { id: "user-1", email: "real@example.com" },
      workspace: { id: "ws-1", name: "Real Co", memberCount: 10 },
      quota: { used: 100_000, limit: 100_000 },
    });

    const res = await post(app, env, {
      message: "we need more",
      // All of this is ignored. Somebody who can type JSON must not be able
      // to tell us they are a hundred-seat account.
      email: "spoofed@example.com",
      workspaceName: "Spoofed Inc",
      memberCount: 900,
    });

    expect(res.status).toBe(200);
    const email = sent.mock.calls[0][0] as { text: string; html: string };
    const body = email.text + email.html;
    expect(body).toContain("real@example.com");
    expect(body).toContain("Real Co");
    expect(body).not.toContain("spoofed@example.com");
    expect(body).not.toContain("Spoofed Inc");
    expect(body).not.toContain("900");
  });

  it("goes to efe@covan.app when SUPPORT_EMAIL is unset", async () => {
    const sent = vi.fn();
    const { app, env } = appWith({ send: sent, supportEmail: undefined });

    await post(app, env, { message: "hello" });

    expect(sent.mock.calls[0][0].to).toBe("efe@covan.app");
  });

  it("goes where SUPPORT_EMAIL says when it is set", async () => {
    const sent = vi.fn();
    const { app, env } = appWith({ send: sent, supportEmail: "ops@self.host" });

    await post(app, env, { message: "hello" });

    expect(sent.mock.calls[0][0].to).toBe("ops@self.host");
  });

  it("names the deployment it came from", async () => {
    const sent = vi.fn();
    const { app, env } = appWith({ send: sent, allowedOrigin: "https://covan.app" });

    await post(app, env, { message: "hello" });

    expect(sent.mock.calls[0][0].text).toContain("https://covan.app");
  });

  it("refuses an empty message", async () => {
    const sent = vi.fn();
    const { app, env } = appWith({ send: sent });

    const res = await post(app, env, { message: "   " });

    expect(res.status).toBe(400);
    expect(sent).not.toHaveBeenCalled();
  });

  it("refuses a message longer than the cap", async () => {
    const { app, env } = appWith({ send: vi.fn() });

    const res = await post(app, env, { message: "x".repeat(4001) });

    expect(res.status).toBe(400);
  });

  it("reports a send failure rather than swallowing it", async () => {
    // The wall is where somebody decides whether this product is worth paying
    // for. A message that silently does not arrive is worse than a refusal.
    const { app, env } = appWith({ send: vi.fn().mockRejectedValue(new Error("resend down")) });

    const res = await post(app, env, { message: "hello" });

    expect(res.status).toBe(502);
  });

  it("reports a Resend error response, not just a rejected fetch", async () => {
    // `sendEmail` returns `Promise<Response>` and does not throw on a non-2xx
    // (`lib/email.ts`) — a bad RESEND_API_KEY resolves a 401 rather than
    // rejecting. A `try/catch` around the call alone never sees this, and the
    // route would answer 200 for a message nobody sent.
    const { app, env } = appWith({
      send: vi.fn().mockResolvedValue(new Response("", { status: 422 })),
    });

    const res = await post(app, env, { message: "hello" });

    expect(res.status).toBe(502);
  });

  it("is rate limited", async () => {
    // `retryAfterSeconds`, not `retryAfter` — see `RateVerdict` in
    // worker/src/lib/ratelimit/types.ts:20.
    const { app, env } = appWith({
      send: vi.fn(),
      rateLimit: { allowed: false, retryAfterSeconds: 60 },
    });

    const res = await post(app, env, { message: "hello" });

    expect(res.status).toBe(429);
  });
});
