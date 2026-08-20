export type IdeaSuggestion = { title: string; detail: string | null };

/**
 * Parse the model's JSON-mode reply into idea candidates. Resilient by design:
 * any malformed / partial / unexpected shape yields [] rather than throwing, so
 * a bad extraction never breaks the request.
 */
export function parseIdeaSuggestions(raw: string): IdeaSuggestion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const ideas = (parsed as { ideas?: unknown } | null)?.ideas;
  if (!Array.isArray(ideas)) return [];

  const out: IdeaSuggestion[] = [];
  for (const item of ideas) {
    if (!item || typeof item !== "object") continue;
    const title = (item as { title?: unknown }).title;
    if (typeof title !== "string" || title.trim().length === 0) continue;
    const rawDetail = (item as { detail?: unknown }).detail;
    const detail = typeof rawDetail === "string" && rawDetail.trim().length > 0 ? rawDetail : null;
    out.push({ title: title.trim(), detail });
  }
  return out;
}

/**
 * Build the extraction prompt: distill the brainstorm so far into a handful of
 * distinct, board-ready idea cards. JSON-only so parseIdeaSuggestions can read it.
 */
export function buildIdeaExtractionMessages(
  transcript: string,
): { role: "system" | "user"; content: string }[] {
  return [
    {
      role: "system",
      content:
        "You extract concrete, distinct ideas from a team's brainstorm conversation. " +
        'Respond ONLY with JSON of the exact shape {"ideas":[{"title":string,"detail":string}]}. ' +
        "Return 3-6 of the strongest, most distinct ideas raised or implied so far. " +
        "title: a short (<= 8 words) name for the idea. detail: one or two sentences of substance. " +
        "Do not invent ideas unrelated to the conversation. No prose outside the JSON.",
    },
    {
      role: "user",
      content: `Conversation so far:\n\n${transcript}`,
    },
  ];
}
