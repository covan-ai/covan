import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import type { Billing, BillingSettings } from "../lib/entitlements";
import { activeWorkspaceTables, fakeDb } from "../test-support/fake-db";
import { billing } from "./billing";

const USER_ID = "user-1";
const WORKSPACE_ID = "workspace-1";

const SETTINGS: BillingSettings = {
  autoTopUp: { available: false, enabled: false, below: 200, amount: 10_000 },
  lowBalance: { enabled: true, below: 200 },
  card: { brand: "visa", last4: "4242" },
};

function app(provider?: Partial<Billing>, apiKeyId?: string) {
  const { db } = fakeDb({ tables: activeWorkspaceTables(USER_ID, WORKSPACE_ID) });
  const a = new Hono<AppEnv>();
  a.use("/*", async (c, next) => {
    c.set("user", { id: USER_ID, email: "ada@acme.test" } as never);
    c.set("db", db as never);
    if (apiKeyId) c.set("apiKeyId" as never, apiKeyId as never);
    c.set("entitlements", { ...(provider ? { billing: provider } : {}) } as never);
    await next();
  });
  a.route("/", billing);
  return { app: a, db };
}

const patch = (body: unknown) => ({
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("billing routes", () => {
  it("says there is nothing to show where the deployment sells no credits", async () => {
    const { app: a } = app();
    expect(await (await a.request("/billing/settings")).json()).toEqual({ available: false });
    expect(await (await a.request("/billing/invoices")).json()).toEqual({ available: false });
    expect((await a.request("/billing/settings", patch({}))).status).toBe(501);
    expect((await a.request("/billing/invoices/i1/pdf")).status).toBe(501);
  });

  it("reads the settings through the caller's own client, for their workspace", async () => {
    const settings = vi.fn(async () => SETTINGS);
    const { app: a, db } = app({ settings });
    const res = await a.request("/billing/settings");
    expect(await res.json()).toEqual({ available: true, ...SETTINGS });
    expect(settings).toHaveBeenCalledWith(db, WORKSPACE_ID);
  });

  it("passes a checked patch on, and refuses anything else", async () => {
    const updateSettings = vi.fn(async () => SETTINGS);
    const { app: a } = app({ updateSettings });

    expect(
      (await a.request("/billing/settings", patch({ lowBalance: { enabled: false } }))).status,
    ).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith(expect.anything(), WORKSPACE_ID, {
      lowBalance: { enabled: false },
    });

    expect((await a.request("/billing/settings", patch({ card: "4242" }))).status).toBe(400);
    expect(
      (await a.request("/billing/settings", patch({ autoTopUp: { amount: -5 } }))).status,
    ).toBe(400);
  });

  it("will not let an API key turn on charging the card", async () => {
    const updateSettings = vi.fn(async () => SETTINGS);
    const { app: a } = app({ updateSettings }, "key-1");
    const res = await a.request("/billing/settings", patch({ autoTopUp: { enabled: true } }));
    expect(res.status).toBe(403);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("answers the provider's refusal as a 403, not a 500", async () => {
    const { app: a } = app({
      invoices: async () => {
        throw Object.assign(new Error("admins only"), { status: 403 });
      },
    });
    expect((await a.request("/billing/invoices")).status).toBe(403);
  });

  it("hands over where an invoice's PDF is, and 404s one that is not theirs", async () => {
    const invoicePdfUrl = vi.fn(async (_db: unknown, _ws: string, id: string) =>
      id === "inv-1" ? "https://billing.example.test/inv-1.pdf" : null,
    );
    const { app: a } = app({ invoicePdfUrl });
    expect(await (await a.request("/billing/invoices/inv-1/pdf")).json()).toEqual({
      url: "https://billing.example.test/inv-1.pdf",
    });
    expect((await a.request("/billing/invoices/inv-2/pdf")).status).toBe(404);
  });
});
