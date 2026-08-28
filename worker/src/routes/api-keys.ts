import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { toEpochMs } from "../lib/dto";
import type { ApiKeyDTO } from "../lib/dto";
import { getActiveWorkspaceId } from "../lib/workspace";
import { generateApiKey } from "../lib/api-keys";

const apiKeys = new Hono<AppEnv>();

const createKeySchema = z.object({
  // Trimmed inside the schema, the way invitations.ts does it: validating first
  // and trimming after rejects "  Nightly report  " as too long or too short
  // before the trim that would have made it fine.
  name: z.string().trim().min(1).max(60),
});

/**
 * Whether this deployment can honour a key at all.
 *
 * A key is exchanged for a minted JWT, and minting needs the project's signing
 * secret. Without it the honest answer to "show me my API keys" is not an empty
 * list — an empty list means "you have none" — but "this deployment does not do
 * that". The interface leaves the section out rather than offering a button that
 * creates a credential nothing would accept.
 */
function keysAreAvailable(c: { env: { SUPABASE_JWT_SECRET?: string } }): boolean {
  return !!c.env.SUPABASE_JWT_SECRET;
}

/**
 * What a key may not do: make another one.
 *
 * Everything else a key can reach is reached as its owner, and RLS decides —
 * that is the whole design. This is the one place where acting as the owner is
 * not enough, because a key that can mint keys cannot be revoked: the moment one
 * leaks it writes successors, and revoking the original leaves every one of them
 * working. The same goes for revocation itself, which a leaked key would
 * otherwise use to take down the keys somebody was still relying on.
 *
 * So both writes require a session. This is a deliberate second permission
 * system, and it is exactly one rule wide.
 */
function refuseIfKeyAuthenticated(c: { get: (k: "apiKeyId") => string | undefined }) {
  return c.get("apiKeyId")
    ? ({ error: "api keys cannot manage api keys — sign in to do this" } as const)
    : null;
}

function mapKey(row: Record<string, unknown>): ApiKeyDTO {
  return {
    id: row.id as string,
    name: row.name as string,
    prefix: row.prefix as string,
    createdAt: toEpochMs(row.created_at as string),
    lastUsedAt: row.last_used_at ? toEpochMs(row.last_used_at as string) : null,
  };
}

// GET /api-keys — the caller's own live keys.
//
// Own, not "keys I am allowed to see": the select policy in 0033 is
// own-keys-only and this filter agrees with it rather than leaning on it, which
// is the arrangement GET /invitations/incoming learned the hard way.
apiKeys.get("/api-keys", async (c) => {
  if (!keysAreAvailable(c)) return c.json({ available: false, keys: [] });

  const db = c.get("db");
  const user = c.get("user");

  const { data, error } = await db
    .from("api_keys")
    .select("id, name, prefix, created_at, last_used_at")
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });

  if (error) return c.json({ error: "failed to load api keys" }, 500);

  return c.json({ available: true, keys: (data ?? []).map(mapKey) });
});

// POST /api-keys — create one, and return the plaintext for the only time.
apiKeys.post("/api-keys", async (c) => {
  if (!keysAreAvailable(c)) {
    return c.json({ error: "api keys are not enabled on this deployment" }, 501);
  }

  const refusal = refuseIfKeyAuthenticated(c);
  if (refusal) return c.json(refusal, 403);

  const parsed = createKeySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const db = c.get("db");
  const user = c.get("user");

  const workspaceId = await getActiveWorkspaceId(db, user.id);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 404);

  const { token, tokenHash, prefix } = await generateApiKey();

  const { data, error } = await db
    .from("api_keys")
    .insert({
      workspace_id: workspaceId,
      user_id: user.id,
      name: parsed.data.name,
      token_hash: tokenHash,
      prefix,
    })
    .select("id, name, prefix, created_at, last_used_at");

  // The insert policy wants ownership and membership; a failure here is one of
  // those, not a fault worth a 500.
  if (error || !data || data.length === 0) {
    return c.json({ error: "could not create a key in this workspace" }, 403);
  }

  // The one response that carries it. Nothing stores the plaintext, so a client
  // that loses this has lost the key rather than mislaid it.
  return c.json({ ...mapKey(data[0]), token }, 201);
});

// DELETE /api-keys/:id — revoke.
//
// A write of `revoked_at`, not a delete: the row is what says a key existed and
// when it stopped, and 0033's trigger makes the change one-way so a revocation
// cannot be replayed back into a working key.
apiKeys.delete("/api-keys/:id", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c);
  if (refusal) return c.json(refusal, 403);

  const db = c.get("db");

  const { data, error } = await db
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", c.req.param("id"))
    .is("revoked_at", null)
    .select("id");

  if (error) return c.json({ error: "failed to revoke api key" }, 500);
  if (!data || data.length === 0) {
    return c.json({ error: "key not found or already revoked" }, 404);
  }
  return c.json({ ok: true });
});

export { apiKeys };
