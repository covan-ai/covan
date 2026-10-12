import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { resolveModel } from "../lib/models";
import { complete } from "../lib/completion";
import { completionSpend } from "../lib/entitlements";
import { buildPersonaMessages, parsePersonaSuggestion } from "../lib/persona-suggest";
import { guardCredits, recordCredits } from "../lib/entitlements/guard";

const persona = new Hono<AppEnv>();

const suggestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  model: z.string().optional(),
});

// POST /persona/suggest — draft a system prompt from an agent's title alone.
// Nothing is persisted: the client drops the text into the persona field, and
// the user saves (or discards) it like anything else they typed.
persona.post("/persona/suggest", async (c) => {
  const denied = await guardCredits(c);
  if (denied) return denied;

  const env = c.env;

  const parsed = suggestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const { name, model } = parsed.data;

  try {
    const resolved = resolveModel(model ?? null, env);
    const { text, usage } = await complete(env, {
      model: resolved,
      messages: buildPersonaMessages(name),
      json: true,
      // A title in, three sentences out: shaping, not thinking. Without this a
      // reasoning model spends the whole 400 deliberating and returns nothing.
      reasoningEffort: "minimal",
      maxTokens: 400,
    });
    await recordCredits(c, completionSpend(resolved, usage, "persona"));
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
