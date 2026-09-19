/**
 * Math rendering for chat replies, fetched the first time a reply contains any.
 *
 * KaTeX is 266 KB of JavaScript and a 24 KB stylesheet, and it used to be a
 * static import in `markdown.tsx` and a bare `@import` in `styles.css` — which
 * put both inside the chat bundle and the stylesheet every page loads,
 * including the ones nobody signed in to see. Most replies contain no math at
 * all. Loading it here means the ones that do pay for it and the rest do not.
 *
 * The stylesheet rides along with the library rather than being imported
 * separately, because arriving apart is the one failure worth avoiding:
 * KaTeX's markup without KaTeX's CSS is not plain text, it is a heap of
 * fragments down the page.
 */

type Renderer = (tex: string, options: Record<string, unknown>) => string;

let instance: Promise<Renderer> | null = null;

function getRenderer(): Promise<Renderer> {
  if (!instance) {
    instance = Promise.all([import("katex"), import("katex/dist/katex.css")]).then(
      ([mod]) => mod.renderToString as Renderer,
    );
  }
  return instance;
}

/**
 * Rendered markup, keyed by expression and mode.
 *
 * This is not a micro-optimisation, it is what keeps a settled formula still
 * while the rest of the answer arrives. `Markdown` re-parses the whole reply on
 * every token, so a `$$` block that closed early in an answer is handed back to
 * this module once per token for the remainder — hundreds of times for a long
 * reply. Cached, the second call onwards is a map lookup.
 */
const rendered = new Map<string, string>();

/**
 * Bounded because the map outlives every reply on the page and a long session
 * keeps finding new expressions. Insertion order is Map's own, so the oldest
 * key is the first one it yields — evicting it costs one iterator step.
 */
const CACHE_LIMIT = 256;

function keyFor(tex: string, displayMode: boolean): string {
  return `${displayMode ? "d" : "i"}:${tex}`;
}

/**
 * What is already rendered, without waiting. Lets a remounted formula paint on
 * its first frame instead of flashing back to its own source — which is what a
 * reader would otherwise see every time a streaming paragraph resettles around
 * it.
 */
export function peekMath(tex: string, displayMode: boolean): string | null {
  return rendered.get(keyFor(tex, displayMode)) ?? null;
}

/**
 * `throwOnError: false` matches the fenced-code path's tolerance for a
 * construct that streams in pieces: an expression that is not valid TeX yet
 * renders as inline error text rather than throwing mid-answer. `trust: false`
 * (KaTeX's own default, pinned rather than relied on) keeps `\href` and
 * `\includegraphics` — the commands that can embed a URL — disabled, since the
 * TeX reaching this is model output and not something this renderer authored.
 */
export async function renderMath(tex: string, displayMode: boolean): Promise<string | null> {
  const cached = peekMath(tex, displayMode);
  if (cached !== null) return cached;
  try {
    const renderToString = await getRenderer();
    const html = renderToString(tex, { throwOnError: false, displayMode, trust: false });
    if (rendered.size >= CACHE_LIMIT) {
      const oldest = rendered.keys().next().value;
      if (oldest !== undefined) rendered.delete(oldest);
    }
    rendered.set(keyFor(tex, displayMode), html);
    return html;
  } catch {
    return null;
  }
}
