import { Hono, type Context } from "hono";
import { z } from "zod";

import type { AppEnv } from "../types";
import { hintFor } from "../lib/keys/crypto";
import {
  clearWorkspaceKey,
  keyStorageConfigured,
  readKeyHints,
  writeWorkspaceKey,
} from "../lib/keys/store";
import { getActiveWorkspaceId } from "../lib/workspace";

/**
 * A workspace's own provider keys.
 *
 * Every other table in this schema is protected by RLS, and the route that
 * writes it leans on that: a non-admin matches zero rows and the handler turns
 * that into a 403. `workspace_provider_keys` has no policy for `authenticated`
 * at all, so there is no RLS to lean on — this file checks the role itself, and
 * `provider-keys.test.ts` is what keeps that honest.
 *
 * Nothing here returns a stored key. `GET` answers with hints, `PUT` answers
 * with the hint of what it just stored, and there is no third shape.
 */

const providerKeys = new Hono<AppEnv>();

const putSchema = z.object({
  provider: z.enum(["openai", "anthropic"]),
  key: z.string().trim().min(8).max(400),
});

const providerSchema = z.enum(["openai", "anthropic"]);

/** The caller's role in their active workspace, or null if they have none. */
async function activeRole(c: Context<AppEnv>) {
  const userId = c.get("user").id;
  const workspaceId = await getActiveWorkspaceId(c.get("db"), userId);
  if (!workspaceId) return { workspaceId: null, role: null, userId };

  const { data } = await c
    .get("db")
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();

  return { workspaceId, role: (data?.role as string | null) ?? null, userId };
}

providerKeys.get("/workspace/provider-keys", async (c) => {
  const { workspaceId } = await activeRole(c);
  const configured = keyStorageConfigured(c.env);

  if (!workspaceId || !configured) {
    return c.json({ configured, openai: null, anthropic: null, updatedAt: null });
  }

  const hints = await readKeyHints(c.env, workspaceId);
  return c.json({ configured, ...hints });
});

providerKeys.put("/workspace/provider-keys", async (c) => {
  if (!keyStorageConfigured(c.env)) {
    // A deployment that has not set PROVIDER_KEY_SECRET does not have this
    // feature. It does not have a broken one, and it does not store a key it
    // cannot encrypt.
    return c.json({ error: "this deployment cannot store provider keys" }, 501);
  }

  const { workspaceId, role, userId } = await activeRole(c);
  if (!workspaceId || role !== "admin") {
    return c.json({ error: "only workspace admins can set a provider key" }, 403);
  }

  const parsed = putSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "provider and key are required" }, 400);

  try {
    await writeWorkspaceKey(c.env, workspaceId, parsed.data.provider, parsed.data.key, userId);
  } catch (err) {
    console.error("could not store a workspace provider key", err);
    return c.json({ error: "could not store the key" }, 500);
  }

  return c.json({ ok: true, hint: hintFor(parsed.data.key) });
});

providerKeys.delete("/workspace/provider-keys/:provider", async (c) => {
  const { workspaceId, role, userId } = await activeRole(c);
  if (!workspaceId || role !== "admin") {
    return c.json({ error: "only workspace admins can remove a provider key" }, 403);
  }

  const provider = providerSchema.safeParse(c.req.param("provider"));
  if (!provider.success) return c.json({ error: "unknown provider" }, 400);

  try {
    await clearWorkspaceKey(c.env, workspaceId, provider.data, userId);
  } catch (err) {
    console.error("could not remove a workspace provider key", err);
    return c.json({ error: "could not remove the key" }, 500);
  }

  return c.json({ ok: true });
});

export { providerKeys };
