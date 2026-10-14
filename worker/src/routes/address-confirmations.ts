import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { confirmAddress } from "../lib/routines/address-confirmation";

/**
 * `POST /address-confirmations` — an address saying yes to routine results.
 *
 * Unauthenticated, because the person at the address may have no Covan
 * account: the token from the link is the whole of the credential, and it
 * names one delivery channel (0096). A POST from a page with a button rather
 * than the link itself, so a mail scanner that follows every link confirms
 * nothing — the same rule `/invite` keeps.
 *
 * One answer for every failure — unknown, used, expired — so the endpoint says
 * nothing about which tokens ever existed. Behind the per-address limit like
 * every other door, and a token is 32 random bytes besides.
 */
export const addressConfirmationsPublic = new Hono<AppEnv>();

const bodySchema = z.object({ token: z.string().min(16).max(200) });

addressConfirmationsPublic.post("/address-confirmations", async (c) => {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "that link is not valid" }, 400);

  const confirmed = await confirmAddress(c.env, parsed.data.token);
  if (!confirmed) return c.json({ error: "that link is not valid" }, 404);
  return c.body(null, 204);
});
