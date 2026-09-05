import type { RoutineEnv } from "../../types";
import { serviceClient } from "../supabase";
import { decryptSecret, encryptSecret, hintFor } from "./crypto";

/**
 * The only code that touches `workspace_provider_keys`.
 *
 * The table has RLS on and no policy for `authenticated`, so there is no
 * request-scoped path to it at all — every read here goes through
 * `service_role`, which means every caller of this module is responsible for
 * having checked who is asking. `routes/provider-keys.ts` is the only writer
 * and it checks the `admin` role before calling in.
 *
 * Reads never throw. This is called mid-request for somebody who has already
 * run out of allowance, and the whole feature's rule is that a failure of ours
 * falls back to the operator's key rather than refusing a reply.
 */

export type Provider = "openai" | "anthropic";

export type WorkspaceKeys = { openai: string | null; anthropic: string | null };
export type KeyHints = {
  openai: string | null;
  anthropic: string | null;
  updatedAt: string | null;
};

const NONE: WorkspaceKeys = { openai: null, anthropic: null };

/** Whether this deployment can store workspace keys at all. */
export function keyStorageConfigured(env: { PROVIDER_KEY_SECRET?: string }): boolean {
  return Boolean(env.PROVIDER_KEY_SECRET);
}

export async function readWorkspaceKeys(
  env: RoutineEnv,
  workspaceId: string,
): Promise<WorkspaceKeys> {
  const secret = env.PROVIDER_KEY_SECRET;
  if (!secret) return NONE;

  try {
    const { data, error } = await serviceClient(env)
      .from("workspace_provider_keys")
      .select("openai_ciphertext, openai_iv, anthropic_ciphertext, anthropic_iv")
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (error || !data) return NONE;

    const open = async (ciphertext: unknown, iv: unknown) =>
      typeof ciphertext === "string" && typeof iv === "string"
        ? await decryptSecret(secret, ciphertext, iv)
        : null;

    return {
      openai: await open(data.openai_ciphertext, data.openai_iv),
      anthropic: await open(data.anthropic_ciphertext, data.anthropic_iv),
    };
  } catch (err) {
    console.error("could not read workspace provider keys", err);
    return NONE;
  }
}

/**
 * What an admin is shown. Column list written out rather than `*`, because a
 * hint reader that selects everything is one refactor away from returning a key.
 */
export async function readKeyHints(env: RoutineEnv, workspaceId: string): Promise<KeyHints> {
  try {
    const { data, error } = await serviceClient(env)
      .from("workspace_provider_keys")
      .select("openai_hint, anthropic_hint, updated_at")
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (error || !data) return { openai: null, anthropic: null, updatedAt: null };
    return {
      openai: (data.openai_hint as string | null) ?? null,
      anthropic: (data.anthropic_hint as string | null) ?? null,
      updatedAt: (data.updated_at as string | null) ?? null,
    };
  } catch (err) {
    console.error("could not read workspace provider key hints", err);
    return { openai: null, anthropic: null, updatedAt: null };
  }
}

export async function writeWorkspaceKey(
  env: RoutineEnv,
  workspaceId: string,
  provider: Provider,
  key: string,
  userId: string,
): Promise<void> {
  const secret = env.PROVIDER_KEY_SECRET;
  if (!secret) throw new Error("PROVIDER_KEY_SECRET is not set");

  const { ciphertext, iv } = await encryptSecret(secret, key);
  const { error } = await serviceClient(env)
    .from("workspace_provider_keys")
    .upsert(
      {
        workspace_id: workspaceId,
        [`${provider}_ciphertext`]: ciphertext,
        [`${provider}_iv`]: iv,
        [`${provider}_hint`]: hintFor(key),
        updated_by: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id" },
    );

  if (error) throw new Error(`could not store the ${provider} key: ${error.message}`);
}

export async function clearWorkspaceKey(
  env: RoutineEnv,
  workspaceId: string,
  provider: Provider,
  userId: string,
): Promise<void> {
  const { error } = await serviceClient(env)
    .from("workspace_provider_keys")
    .upsert(
      {
        workspace_id: workspaceId,
        [`${provider}_ciphertext`]: null,
        [`${provider}_iv`]: null,
        [`${provider}_hint`]: null,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id" },
    );

  if (error) throw new Error(`could not remove the ${provider} key: ${error.message}`);
}
