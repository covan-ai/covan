import type { SupabaseClient } from "@supabase/supabase-js";
import { ENDPOINT_PREFIX, isEndpointModel } from "./models";
import { decryptSecret } from "./secret-box";
import { assertFetchableUrl, ownHostsFrom } from "./routines/url-guard";
import { resolvesPublicly } from "./routines/source";
import type { ModelEndpointRoute } from "./completion";

/**
 * Routes a request to a workspace's own endpoint (0135), when its model is
 * one: the env comes back carrying the endpoint's address, the model's name
 * there and its key, opened for this request alone; otherwise it comes back
 * as it went in.
 *
 * SCOPING: called with the service role, because no client may read the
 * sealed key. The endpoint is looked up by the id the model column names AND
 * the workspace the request runs in, so a model column pointing at another
 * workspace's endpoint opens nothing. The host is checked against the
 * network again, as a webhook's is on every try: public when it was saved
 * is not public now. An endpoint that is gone, removed or no longer public
 * leaves the env unrouted, and `resolveModel` answers on the default.
 */
export async function withModelEndpoint<
  E extends {
    MODEL_ENDPOINT?: ModelEndpointRoute;
    ROUTINE_SECRET_KEY?: string;
    ALLOWED_ORIGIN?: string;
    WORKER_HOST?: string;
  },
>(
  env: E,
  service: SupabaseClient,
  workspaceId: string,
  model: string | null | undefined,
): Promise<E> {
  if (!model || !isEndpointModel(model)) return env;
  try {
    const { data, error } = await service
      .from("workspace_model_endpoints")
      .select("id, model, base_url, api_key_ciphertext")
      .eq("id", model.slice(ENDPOINT_PREFIX.length))
      .eq("workspace_id", workspaceId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error || !data) return env;
    const url = assertFetchableUrl(
      String(data.base_url),
      ownHostsFrom({
        ALLOWED_ORIGIN: env.ALLOWED_ORIGIN ?? "",
        WORKER_HOST: env.WORKER_HOST,
      }),
    );
    await resolvesPublicly(url.hostname);
    const apiKey = data.api_key_ciphertext
      ? await decryptSecret(String(data.api_key_ciphertext), env.ROUTINE_SECRET_KEY ?? "")
      : // The SDK will not send a request without one; an endpoint that asks
        // for none ignores it.
        "none";
    return {
      ...env,
      MODEL_ENDPOINT: { id: model, model: String(data.model), baseUrl: url.toString(), apiKey },
    };
  } catch (err) {
    console.error(
      "model endpoint: could not route to it",
      err instanceof Error ? err.message : err,
    );
    return env;
  }
}

/**
 * Whether the caller can see the endpoint a model id names — every member of
 * its workspace can (0135) — so a model column is never pointed at one that
 * is not theirs. Asked through the caller's own client.
 */
export async function endpointIsVisible(db: SupabaseClient, model: string): Promise<boolean> {
  if (!isEndpointModel(model)) return true;
  const { data, error } = await db
    .from("workspace_model_endpoints")
    .select("id")
    .eq("id", model.slice(ENDPOINT_PREFIX.length))
    .is("deleted_at", null)
    .maybeSingle();
  return !error && Boolean(data);
}
