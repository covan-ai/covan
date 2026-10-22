import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { callerWorkspaceId } from "../lib/workspace";
import { encryptSecret } from "../lib/secret-box";
import { assertFetchableUrl, ownHostsFrom } from "../lib/routines/url-guard";
import { resolvesPublicly } from "../lib/routines/source";
import { endpointModelId } from "../lib/models";
import { refuseIfKeyAuthenticated } from "../lib/api-key-rule";
import { toEpochMs } from "../lib/dto";

/**
 * A workspace's own model endpoints (0135): "Add a custom endpoint for a
 * self-hosted or OpenAI-compatible model" (A10).
 *
 * Through the caller's own client throughout. Every member lists them, so a
 * picker can offer them; an admin adds and removes them, and the policies say
 * so. The key is sealed here and written once; nothing reads it back but the
 * engine, when a reply is asked of that model (`lib/model-endpoints.ts`).
 */
const modelEndpoints = new Hono<AppEnv>();

export type ModelEndpointDTO = {
  id: string;
  /** What a model column holds to mean this endpoint: `endpoint:<id>`. */
  modelId: string;
  label: string;
  /** The model's name at the endpoint. */
  model: string;
  /** The host alone, for "via acme-openai-proxy" and nothing more. */
  host: string;
  createdBy: string | null;
  createdAt: number;
};

const COLUMNS = "id, label, model, base_url, created_by, created_at";

function mapEndpoint(row: Record<string, unknown>): ModelEndpointDTO {
  let host = "";
  try {
    host = new URL(String(row.base_url)).host;
  } catch {
    // A row the shape check let through is a URL; this is belt and braces.
  }
  return {
    id: row.id as string,
    modelId: endpointModelId(row.id as string),
    label: row.label as string,
    model: row.model as string,
    host,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: toEpochMs(row.created_at as string),
  };
}

modelEndpoints.get("/model-endpoints", async (c) => {
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json([]);
  const { data, error } = await c
    .get("db")
    .from("workspace_model_endpoints")
    .select(COLUMNS)
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) return c.json({ error: "failed to load model endpoints" }, 500);
  return c.json((data ?? []).map(mapEndpoint));
});

const createSchema = z.object({
  label: z.string().trim().min(1).max(60),
  model: z.string().trim().min(1).max(200),
  baseUrl: z.string().trim().min(1).max(500),
  /** Optional: a server on a private network of its own may want none. */
  apiKey: z.string().max(2000).optional(),
});

modelEndpoints.post("/model-endpoints", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "add a model endpoint");
  if (refusal) return c.json(refusal, 403);
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const body = parsed.data;

  // Where replies will be sent with the workspace's threads in them: https,
  // a public host, and not this install. Checked again on every use.
  let url: URL;
  try {
    url = assertFetchableUrl(body.baseUrl, ownHostsFrom(c.env));
    await resolvesPublicly(url.hostname);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "that is not a usable URL" }, 400);
  }
  if (url.protocol !== "https:") return c.json({ error: "an endpoint must be https" }, 400);
  if (url.username || url.password) {
    return c.json({ error: "put the key in its own field, not in the URL" }, 400);
  }

  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no active workspace" }, 400);
  const { data, error } = await c
    .get("db")
    .from("workspace_model_endpoints")
    .insert({
      workspace_id: workspaceId,
      label: body.label,
      model: body.model,
      base_url: url.toString().replace(/\/$/, ""),
      api_key_ciphertext: body.apiKey?.trim()
        ? await encryptSecret(body.apiKey.trim(), c.env.ROUTINE_SECRET_KEY)
        : null,
      created_by: c.get("user").id,
    })
    .select(COLUMNS)
    .single();
  if (error || !data) {
    return error?.code === "42501"
      ? c.json({ error: "only admins can add a model endpoint" }, 403)
      : c.json({ error: "failed to add the model endpoint" }, 500);
  }
  return c.json(mapEndpoint(data), 201);
});

// Marked removed rather than deleted, so a reply it wrote can still say
// which endpoint that was. An agent on it answers on the default from now.
modelEndpoints.delete("/model-endpoints/:id", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "remove a model endpoint");
  if (refusal) return c.json(refusal, 403);
  const { data, error } = await c
    .get("db")
    .from("workspace_model_endpoints")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", c.req.param("id"))
    .is("deleted_at", null)
    .select("id");
  if (error) return c.json({ error: "failed to remove the model endpoint" }, 500);
  if (!data?.length) return c.json({ error: "model endpoint not found" }, 404);
  return c.body(null, 204);
});

export { modelEndpoints };
