import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { activeWorkspaceTables, fakeDb } from "../test-support/fake-db";
import { providerKeys } from "./provider-keys";

/**
 * The route is the only writer, and the table has no policy for `authenticated`
 * — so the admin check is the route's own job, not RLS's. That is a deviation
 * from how every other table in this schema is protected (see workspace.test.ts,
 * where a non-admin write turns into "0 rows" and the handler reads that as
 * 403), and these tests are what make it safe here instead.
 *
 * `lib/keys/store` talks to `service_role` directly — there is no
 * request-scoped path to it for the fake db to intercept — so it is mocked at
 * the module boundary, the same way chat.test.ts mocks `lib/embeddings` and
 * `lib/openai`. Role resolution still goes through the real `activeRole`
 * helper against the fake db, because that is the part under test.
 */

const readKeyHints = vi.fn();
const writeWorkspaceKey = vi.fn();
const clearWorkspaceKey = vi.fn();
const keyStorageConfigured = vi.fn();

vi.mock("../lib/keys/store", () => ({
  readKeyHints: (...args: unknown[]) => readKeyHints(...args),
  writeWorkspaceKey: (...args: unknown[]) => writeWorkspaceKey(...args),
  clearWorkspaceKey: (...args: unknown[]) => clearWorkspaceKey(...args),
  keyStorageConfigured: (...args: unknown[]) => keyStorageConfigured(...args),
}));

const USER = { id: "user-1", email: "admin@example.com" };
const WORKSPACE = "ws-1";

// Hono's third `.request()` argument is the Bindings object. `keyStorageConfigured`
// and the store functions are mocked above, so its contents never matter to the
// route — but it has to be *something*, so that `expect.anything()` below can
// tell "the environment was passed through" from "nothing was passed at all".
const ENV: Record<string, string> = { PROVIDER_KEY_SECRET: "test-secret" };

type Hints = { openai: string | null; anthropic: string | null; updatedAt: string | null };

function appWith(opts: {
  role: "admin" | "member" | "viewer";
  hints?: Hints;
  configured?: boolean;
}) {
  keyStorageConfigured.mockReturnValue(opts.configured ?? true);
  readKeyHints.mockResolvedValue(opts.hints ?? { openai: null, anthropic: null, updatedAt: null });
  writeWorkspaceKey.mockResolvedValue(undefined);
  clearWorkspaceKey.mockResolvedValue(undefined);

  const fake = fakeDb({
    tables: {
      ...activeWorkspaceTables(USER.id, WORKSPACE),
      // Overrides activeWorkspaceTables' workspace_members handler: this route
      // reads `role` off the same table getActiveWorkspaceId already queried,
      // so one handler has to answer both shapes (`workspace_id` for the
      // membership check, `role` for the admin check).
      workspace_members: {
        select: () => ({ data: { workspace_id: WORKSPACE, role: opts.role }, error: null }),
      },
    },
  });

  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", fake.db as never);
    await next();
  });
  app.route("/", providerKeys);

  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /workspace/provider-keys", () => {
  it("returns hints and never a key", async () => {
    const app = appWith({
      role: "admin",
      hints: { openai: "sk-…4f2a", anthropic: null, updatedAt: "2026-09-05T00:00:00Z" },
    });
    const res = await app.request("/workspace/provider-keys");
    const body = (await res.json()) as { openai: string | null; configured: boolean };

    expect(res.status).toBe(200);
    expect(body.openai).toBe("sk-…4f2a");
    expect(JSON.stringify(body)).not.toMatch(/ciphertext|sk-proj|sk-ant/);
  });

  it("says so when the deployment cannot store keys", async () => {
    const app = appWith({ role: "admin", configured: false });
    const body = (await (await app.request("/workspace/provider-keys")).json()) as {
      configured: boolean;
    };

    expect(body.configured).toBe(false);
    expect(readKeyHints).not.toHaveBeenCalled();
  });
});

describe("PUT /workspace/provider-keys", () => {
  const put = (app: Hono<AppEnv>) =>
    app.request(
      "/workspace/provider-keys",
      {
        method: "PUT",
        body: JSON.stringify({ provider: "openai", key: "sk-proj-abcdef123456" }),
        headers: { "Content-Type": "application/json" },
      },
      ENV,
    );

  it("stores a key for an admin and answers with the hint", async () => {
    const app = appWith({ role: "admin" });
    const res = await put(app);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, hint: "sk-…3456" });
    expect(writeWorkspaceKey).toHaveBeenCalledWith(
      expect.anything(),
      "ws-1",
      "openai",
      "sk-proj-abcdef123456",
      "user-1",
    );
  });

  it("refuses a member", async () => {
    const app = appWith({ role: "member" });
    const res = await put(app);

    expect(res.status).toBe(403);
    expect(writeWorkspaceKey).not.toHaveBeenCalled();
  });

  it("refuses a viewer", async () => {
    const app = appWith({ role: "viewer" });
    const res = await put(app);

    expect(res.status).toBe(403);
    expect(writeWorkspaceKey).not.toHaveBeenCalled();
  });

  it("answers 501 when the deployment has no PROVIDER_KEY_SECRET", async () => {
    const app = appWith({ role: "admin", configured: false });
    const res = await put(app);

    expect(res.status).toBe(501);
    expect(writeWorkspaceKey).not.toHaveBeenCalled();
  });

  it("refuses an unknown provider", async () => {
    const app = appWith({ role: "admin" });
    const res = await app.request("/workspace/provider-keys", {
      method: "PUT",
      body: JSON.stringify({ provider: "gemini", key: "sk-proj-abcdef123456" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(writeWorkspaceKey).not.toHaveBeenCalled();
  });

  it("refuses an empty key", async () => {
    const app = appWith({ role: "admin" });
    const res = await app.request("/workspace/provider-keys", {
      method: "PUT",
      body: JSON.stringify({ provider: "openai", key: "   " }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(writeWorkspaceKey).not.toHaveBeenCalled();
  });
});

describe("DELETE /workspace/provider-keys/:provider", () => {
  it("clears for an admin", async () => {
    const app = appWith({ role: "admin" });
    const res = await app.request("/workspace/provider-keys/openai", { method: "DELETE" }, ENV);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(clearWorkspaceKey).toHaveBeenCalledWith(expect.anything(), "ws-1", "openai", "user-1");
  });

  it("refuses a member", async () => {
    const app = appWith({ role: "member" });
    const res = await app.request("/workspace/provider-keys/openai", { method: "DELETE" }, ENV);

    expect(res.status).toBe(403);
    expect(clearWorkspaceKey).not.toHaveBeenCalled();
  });
});
