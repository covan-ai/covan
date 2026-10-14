/**
 * Markdown, as Slack actually reads it.
 *
 * The model writes Markdown. Every other surface in Covan renders Markdown, so
 * that is the right thing for it to write — but Slack's `text` field is not
 * Markdown, it is *mrkdwn*, which is a different language that happens to look
 * similar. `**bold**` is not bold there; it is two asterisks, a word, and two
 * more asterisks. `[the policy](https://…)` is not a link; it is the label and
 * then the URL in brackets, both visible.
 *
 * So every answer this app posted arrived with its formatting showing. The
 * citation line underneath it was correct — `_From: …_` is mrkdwn italic — which
 * is the tell: the language was known and the answer simply never went through
 * it.
 *
 * What is different, in the order it matters:
 *
 * | Markdown        | mrkdwn          |
 * | --------------- | --------------- |
 * | `**bold**`      | `*bold*`        |
 * | `*italic*`      | `_italic_`      |
 * | `~~strike~~`    | `~strike~`      |
 * | `[a](url)`      | `<url\|a>`      |
 * | `# Heading`     | `*Heading*`     |
 * | `- item`        | `• item`        |
 *
 * Code fences and inline code are the same in both, and are the reason this is
 * a small parser rather than a list of replacements: the contents of a fence
 * must survive unconverted, or an answer explaining a Markdown syntax error
 * rewrites the very thing it is explaining. (Escaped, though — see `toMrkdwn`.)
 *
 * There are no placeholders anywhere below, deliberately. The obvious way to
 * write this is to swap the awkward constructs for sentinels and swap them back
 * at the end, and the awkward constructs are exactly the ones a sentinel can be
 * confused with. Splitting the text and converting only the parts that are
 * prose has no such failure.
 */

/** A Markdown link, which is the one construct that must be cut out whole. */
const LINK = /\[([^\]\n]*)\]\(([^)\s]+)\)/g;

/**
 * The characters Slack reads as markup.
 *
 * `>` is deliberately not escaped: at the start of a line it is a blockquote in
 * mrkdwn too, and escaping it would turn every quoted passage into a visible
 * `&gt;`. Mid-sentence it is harmless, which is the trade this makes.
 */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

const escape = escapeMrkdwn;

/**
 * A link target Slack may be handed as one.
 *
 * Inside `<…>` Slack reads more than URLs: `<!channel>`, `<!here>`,
 * `<!everyone>`, `<@U123>`, `<#C123>`. The answer is model output over
 * retrieved documents, so `[read this](!channel)` in a document was a ping to
 * the whole channel from the bot. Only an http(s) or mailto address with
 * nothing in it that could close the link or start a second one is made a
 * link; anything else is shown as the text it is.
 */
function linkTarget(raw: string): string | null {
  if (!/^(https?:\/\/|mailto:)/i.test(raw)) return null;
  if (/[<>|\s]/.test(raw)) return null;
  return raw.replace(/&/g, "&amp;");
}

/** Prose with no links in it, converted. */
function convertPlain(input: string): string {
  // A Markdown autolink is already a bare URL to Slack, which linkifies it
  // itself. Unwrapping it before the escape below is what stops it arriving as
  // `&lt;https://…&gt;`.
  let text = escape(input.replace(/<(https?:\/\/[^>\s]+)>/g, "$1"));

  // Italic before bold, which is the ordering the whole function turns on.
  // mrkdwn spells italic `*`, so converting bold first would produce `*x*` and
  // leave the italic rule unable to tell what it was looking at. Going the
  // other way, the lookarounds mean a `**` is never mistaken for a `*`.
  text = text.replace(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, "_$1_");
  text = text.replace(/\*\*([^\n]+?)\*\*/g, "*$1*");
  text = text.replace(/__([^\n]+?)__/g, "*$1*");
  text = text.replace(/~~([^\n]+?)~~/g, "~$1~");

  return text
    .split("\n")
    .map((line) => {
      // mrkdwn has no headings at all. Bold is what a heading is for here:
      // something that reads as a heading in a wall of text.
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if (heading) return heading[1].trim() ? `*${heading[1].trim()}*` : "";

      // Nor lists. A bullet character is what everybody types by hand, and it
      // keeps the indentation that shows which level an item is at.
      const bullet = line.match(/^([ \t]*)[-*+]\s+(.*)$/);
      if (bullet) return `${bullet[1]}• ${bullet[2]}`;

      return line;
    })
    .join("\n");
}

/** Prose, with its links cut out and rebuilt in Slack's spelling. */
function convertProse(input: string): string {
  const out: string[] = [];
  let last = 0;

  for (const match of input.matchAll(LINK)) {
    const at = match.index ?? 0;
    out.push(convertPlain(input.slice(last, at)));

    // The label is text and is escaped. The URL is only checked, not escaped
    // past its ampersands — escaping it is how you hand Slack a link that does
    // not work — so anything that is not plainly a web or mail address stays
    // text instead.
    const label = escape(match[1]).trim();
    const target = linkTarget(match[2]);
    if (!target) out.push(label ? `${label} (${escape(match[2])})` : escape(match[2]));
    else out.push(label ? `<${target}|${label}>` : `<${target}>`);
    last = at + match[0].length;
  }

  out.push(convertPlain(input.slice(last)));
  return out.join("");
}

/**
 * An answer, ready for `chat.postMessage`.
 *
 * Code is split out first and passed through unconverted — both fenced blocks and
 * inline spans, since mrkdwn spells them the way Markdown does. An unclosed
 * fence is matched too, and deliberately: a model that runs out of room leaves
 * one open, and treating the remainder as code is a far better failure than
 * turning half a code sample into bullet points.
 */
export function toMrkdwn(markdown: string): string {
  const parts = markdown.split(/(```[\s\S]*?```|```[\s\S]*$|`[^`\n]+`)/g);
  // Code is not converted, but it is escaped: `<` opens a control sequence
  // wherever it appears in a message's text, and Slack shows `&lt;` as `<`
  // inside code exactly as it does outside it.
  return parts.map((part, index) => (index % 2 === 1 ? escape(part) : convertProse(part))).join("");
}
