import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { resolveModel } from "../lib/models";
import { complete, totalTokens } from "../lib/completion";
import { buildPersonaMessages, parsePersonaSuggestion } from "../lib/persona-suggest";
import { guardQuota, recordQuota } from "../lib/entitlements/guard";

const persona = new Hono<AppEnv>();

const suggestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  model: z.string().optional(),
});

// POST /persona/suggest — draft a system prompt from an agent's title alone.
// Nothing is persisted: the client drops the text into the persona field, and
// the user saves (or discards) it like anything else they typed.
persona.post("/persona/suggest", async (c) => {
  const denied = await guardQuota(c);
  if (denied) return denied;

  const parsed = suggestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const { name, model } = parsed.data;

  try {
    const { text, usage } = await complete(c.env, {
      model: resolveModel(model ?? null, c.env),
      messages: buildPersonaMessages(name),
      json: true,
      // A title in, three sentences out: shaping, not thinking. Without this a
      // reasoning model spends the whole 400 deliberating and returns nothing.
      reasoningEffort: "minimal",
      maxTokens: 400,
    });
    await recordQuota(c, totalTokens(usage));
    const drafted = parsePersonaSuggestion(text);
    if (!drafted) {
      return c.json({ error: "failed to draft persona" }, 502);
    }
    return c.json({ persona: drafted });
  } catch (err) {
    console.error("persona drafting failed", err);
    return c.json({ error: "failed to draft persona" }, 502);
  }
});

export { persona };
