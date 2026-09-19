import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/**
 * Syntax highlighting for fenced code blocks in chat replies.
 *
 * Assembled from Shiki's core rather than imported from `shiki` directly, and
 * the difference is entirely a build one: the package root is `bundle/full`,
 * which reaches every language Shiki knows through a dynamic import map. The
 * bundler cannot tell which of those the app will ask for — it has to assume
 * all of them — so it emitted a chunk per language for a list of fifteen. None
 * of the surplus was reachable: `resolveLang` turns away anything outside
 * `LANG_LOADERS`, so `highlight()` returned null long before Shiki was
 * consulted. Measured across the whole client build, moving to this file took
 * `.output/public/assets` from 396 chunks and 15 MB to 105 and 6.5 MB.
 *
 * The engine is the other half. Oniguruma is a WASM build of the regex engine
 * TextMate grammars were written against, and it arrived as a 607 KB chunk the
 * first time anybody's reply contained code. Shiki's JavaScript engine runs the
 * same grammars on the platform's own RegExp, which not every grammar survives
 * — so all fifteen below were checked against it before this was written, with
 * `forgiving` off. All fifteen highlight, none warns.
 */

/**
 * One dynamic import per language, written out rather than built from the name.
 *
 * `import(`@shikijs/langs/${lang}`)` reads better and does the wrong thing:
 * a specifier the bundler cannot resolve statically is either left alone — a
 * bare specifier the browser cannot fetch — or widened back into a glob over
 * the whole package, which is the problem this file exists to avoid. Fifteen
 * literal specifiers are fifteen chunks, each fetched the first time a reply
 * contains that language and never otherwise. It matters most for the ones
 * nobody thinks of as large: `cpp` alone is 767 KB.
 */
const LANG_LOADERS = {
  typescript: () => import("@shikijs/langs/typescript"),
  javascript: () => import("@shikijs/langs/javascript"),
  python: () => import("@shikijs/langs/python"),
  bash: () => import("@shikijs/langs/bash"),
  json: () => import("@shikijs/langs/json"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  sql: () => import("@shikijs/langs/sql"),
  go: () => import("@shikijs/langs/go"),
  rust: () => import("@shikijs/langs/rust"),
  java: () => import("@shikijs/langs/java"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  ruby: () => import("@shikijs/langs/ruby"),
  yaml: () => import("@shikijs/langs/yaml"),
} as const;

type Lang = keyof typeof LANG_LOADERS;

const LANG_ALIASES: Record<string, Lang> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  "c++": "cpp",
  rb: "ruby",
  tsx: "typescript",
  jsx: "javascript",
};

const THEME = "github-dark-default";

let instance: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  if (!instance) {
    instance = createHighlighterCore({
      themes: [import("@shikijs/themes/github-dark-default")],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return instance;
}

/**
 * Grammars are registered once each. The promise is cached rather than the
 * fact, so two code blocks in the same reply — the common case — wait on one
 * fetch instead of racing to start two.
 */
const loading = new Map<Lang, Promise<void>>();

function loadLang(h: HighlighterCore, lang: Lang): Promise<void> {
  let pending = loading.get(lang);
  if (!pending) {
    pending = h.loadLanguage(LANG_LOADERS[lang]()).then(() => undefined);
    loading.set(lang, pending);
  }
  return pending;
}

function resolveLang(lang: string): Lang | null {
  const lower = lang.toLowerCase();
  if (lower in LANG_LOADERS) return lower as Lang;
  return LANG_ALIASES[lower] ?? null;
}

export async function highlight(code: string, lang: string): Promise<string | null> {
  const resolved = resolveLang(lang);
  if (!resolved) return null;
  try {
    const h = await getHighlighter();
    await loadLang(h, resolved);
    return h.codeToHtml(code, { lang: resolved, theme: THEME });
  } catch {
    return null;
  }
}
