import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { callerWorkspaceId } from "../lib/workspace";
import { refuseIfKeyAuthenticated } from "../lib/api-key-rule";

/**
 * Settings › Usage and billing's paying half (A15): auto top-up, the
 * low-balance warning, the card on file and the invoices.
 *
 * All of it is the hosted build's (`Entitlements.billing`). Without it the
 * reads answer `available: false`, as the workspace usage does before its
 * migration, and the screen leaves the rows out; the writes answer 501.
 */
const billing = new Hono<AppEnv>();

const UNAVAILABLE = { available: false as const };

const patchSchema = z
  .object({
    autoTopUp: z
      .object({
        enabled: z.boolean().optional(),
        below: z.number().int().min(0).max(1_000_000).optional(),
        amount: z.number().int().min(1).max(1_000_000).optional(),
      })
      .strict()
      .optional(),
    lowBalance: z
      .object({
        enabled: z.boolean().optional(),
        below: z.number().int().min(0).max(1_000_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function failed(c: Context<AppEnv>, what: string, err: unknown) {
  const status = (err as { status?: number })?.status;
  if (status === 403) return c.json({ error: "admins only" }, 403);
  console.error(`billing ${what} failed`, err);
  return c.json({ error: `failed to load ${what}` }, 500);
}

billing.get("/billing/settings", async (c) => {
  const provider = c.get("entitlements").billing;
  if (!provider) return c.json(UNAVAILABLE);
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 404);
  try {
    return c.json({ available: true, ...(await provider.settings(c.get("db"), workspaceId)) });
  } catch (err) {
    return failed(c, "settings", err);
  }
});

billing.patch("/billing/settings", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "change billing settings");
  if (refusal) return c.json(refusal, 403);
  const provider = c.get("entitlements").billing;
  if (!provider) return c.json({ error: "this deployment does not sell credits" }, 501);
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 404);
  try {
    const next = await provider.updateSettings(c.get("db"), workspaceId, parsed.data);
    return c.json({ available: true, ...next });
  } catch (err) {
    return failed(c, "settings", err);
  }
});

billing.get("/billing/invoices", async (c) => {
  const provider = c.get("entitlements").billing;
  if (!provider) return c.json(UNAVAILABLE);
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 404);
  try {
    return c.json({ available: true, invoices: await provider.invoices(c.get("db"), workspaceId) });
  } catch (err) {
    return failed(c, "invoices", err);
  }
});

billing.get("/billing/invoices/:id/pdf", async (c) => {
  const provider = c.get("entitlements").billing;
  if (!provider) return c.json({ error: "this deployment does not sell credits" }, 501);
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 404);
  try {
    const url = await provider.invoicePdfUrl(c.get("db"), workspaceId, c.req.param("id"));
    return url ? c.json({ url }) : c.json({ error: "no such invoice" }, 404);
  } catch (err) {
    return failed(c, "the invoice", err);
  }
});

export { billing };
