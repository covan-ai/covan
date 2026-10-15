import { z } from "zod";

/**
 * The plan for a document, and what is done with a plan that did not parse.
 *
 * The outline call asks for JSON and usually gets it. When it does not — a
 * model that wraps the object in prose, or answers with a list — the job does
 * not fail: it falls back to a single section headed with the title, which is
 * the old Report button's one-call document written by the new engine. A
 * document in one part is a worse document; no document at all is a failure
 * the person has to notice and retry.
 */

/** Twelve parts of up to ~3,000 words each is a long report already. */
export const MAX_SECTIONS = 12;
export const MAX_HEADING_CHARS = 120;
export const MAX_BRIEF_CHARS = 600;

export type OutlineSection = { heading: string; brief: string };
export type Outline = { title: string; sections: OutlineSection[] };

const schema = z.object({
  title: z.string().optional(),
  sections: z
    .array(
      z.object({
        heading: z.string(),
        brief: z.string().optional(),
      }),
    )
    .min(1),
});

/** Strips a fence or prose around the one object a model was asked for. */
function objectIn(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function clean(text: string, max: number): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^#+\s*/, "")
    .trim()
    .slice(0, max);
}

export function parseOutline(text: string, fallbackTitle: string): Outline {
  const parsed = schema.safeParse(objectIn(text));
  const title = clean(fallbackTitle, MAX_HEADING_CHARS) || "Report";
  if (!parsed.success) return { title, sections: [{ heading: title, brief: "" }] };

  const sections = parsed.data.sections
    .map((s) => ({
      heading: clean(s.heading, MAX_HEADING_CHARS),
      brief: clean(s.brief ?? "", MAX_BRIEF_CHARS),
    }))
    .filter((s) => s.heading.length > 0)
    .slice(0, MAX_SECTIONS);

  const named = clean(parsed.data.title ?? "", MAX_HEADING_CHARS);
  return {
    title: named || title,
    sections: sections.length > 0 ? sections : [{ heading: title, brief: "" }],
  };
}

/**
 * A heading the model wrote anyway, despite being told the engine adds it.
 *
 * Only the first line, and only when it is a heading at level one or two —
 * the `### ` sub-headings the part is allowed are left where they are.
 */
export function stripLeadingHeading(body: string): string {
  return body.replace(/^\s*#{1,2}[ \t]+[^\n]*\n+/, "").trim();
}

/** The whole document, as it is filed and as it is exported. */
export function assembleDocument(
  title: string,
  sections: Array<{ heading: string; body: string }>,
): string {
  const parts = sections.map((s) => `## ${s.heading}\n\n${s.body.trim()}`);
  return `# ${title}\n\n${parts.join("\n\n")}\n`;
}
