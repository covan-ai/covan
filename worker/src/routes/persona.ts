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

/**
 * How long a drafted persona may be, in output tokens.
 *
 * This was 400, sized to GPT: the ledger shows gpt-4.1 drafts of 77–120
 * tokens. Claude writes the same brief two to three times longer — 130 to
 * 400 on the sonnet and opus models — and a Turkish title, which the prompt
 * answers in Turkish, costs it the most tokens of all. On 2026-10-21 four
 * Claude 5 drafts in a row stopped at exactly 400: the JSON was cut mid-string,
 * the parse below failed, and "Write from name" reported a failure for a
 * persona that had been written and paid for.
 *
 * 1200 is three times the longest draft the ledger has seen. It is a ceiling,
 * not a target: a three-to-five-sentence persona never approaches it, and the
 * provider bills what was written, not what was allowed.
 */
const PERSONA_MAX_TOKENS = 1200;

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
    const { text, usage, finishReason } = await complete(env, {
      model: resolved,
      messages: buildPersonaMessages(name),
      json: true,
      // A title in, three sentences out: shaping, not thinking. Without this a
      // reasoning model spends the whole ceiling deliberating and returns nothing.
      reasoningEffort: "minimal",
      maxTokens: PERSONA_MAX_TOKENS,
    });
    await recordCredits(c, completionSpend(resolved, usage, "persona"));
    // A draft that hit the ceiling is not JSON and never will be, so it is
    // named for what it is rather than reported as a model that failed to
    // follow the format. Charged above either way: the provider wrote it.
    if (finishReason === "length") {
      console.error("persona draft cut off at the ceiling", { model: resolved, name });
      return c.json({ error: "persona draft was cut off" }, 502);
    }
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
