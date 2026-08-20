/**
 * Parse the model's JSON-mode reply into a persona string. Resilient by design:
 * any malformed / partial / unexpected shape yields null rather than throwing, so
 * a bad generation never breaks the request — the caller reports it as a failure
 * and the user's existing persona text is left untouched.
 */
export function parsePersonaSuggestion(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const persona = (parsed as { persona?: unknown } | null)?.persona;
  if (typeof persona !== "string") return null;
  const trimmed = persona.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build the drafting prompt: turn a bare agent title into a usable system prompt.
 * JSON-only so parsePersonaSuggestion can read it. The persona is written in the
 * title's own language, so a Turkish title produces a Turkish persona.
 */
export function buildPersonaMessages(name: string): { role: "system" | "user"; content: string }[] {
  return [
    {
      role: "system",
      content:
        "You write system prompts (personas) for AI assistants that a team will chat with. " +
        'Respond ONLY with JSON of the exact shape {"persona":string}. ' +
        "Given only the assistant's job title, write 3-5 sentences addressed to the assistant as " +
        '"You are …", covering: the role it plays, the expertise it brings, the tone it speaks in, ' +
        "and how it should shape its answers. Be concrete and specific to the title — no filler, " +
        "no promises about capabilities it may not have. Write it in the same language as the title. " +
        "Plain prose only: no markdown, no headings, no bullet lists, no prose outside the JSON.",
    },
    {
      role: "user",
      content: `Agent title: ${name}`,
    },
  ];
}
