import { type Highlighter, createHighlighter } from "shiki";

const LANGS = [
  "typescript",
  "javascript",
  "python",
  "bash",
  "json",
  "html",
  "css",
  "sql",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "ruby",
  "yaml",
] as const;

const LANG_ALIASES: Record<string, string> = {
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

let instance: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!instance) {
    instance = createHighlighter({
      themes: ["github-dark-default"],
      langs: [...LANGS],
    });
  }
  return instance;
}

function resolveLang(lang: string): string | null {
  const lower = lang.toLowerCase();
  if ((LANGS as readonly string[]).includes(lower)) return lower;
  return LANG_ALIASES[lower] ?? null;
}

export async function highlight(
  code: string,
  lang: string,
): Promise<string | null> {
  const resolved = resolveLang(lang);
  if (!resolved) return null;
  try {
    const h = await getHighlighter();
    return h.codeToHtml(code, { lang: resolved, theme: "github-dark-default" });
  } catch {
    return null;
  }
}
