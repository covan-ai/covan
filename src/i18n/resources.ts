import type { Resource } from "i18next";

/**
 * The catalogues, found rather than listed.
 *
 * This is the one file allowed to read `./locales/`; the static test next
 * to it checks that nothing else does. A glob rather than two imports so the
 * hosted tree can add `en.cloud.json` and `tr.cloud.json` for its own pages
 * without this file — which both trees share byte for byte — knowing.
 * Every `<lang>*.json` folds into that language's one namespace.
 */
const files = import.meta.glob("./locales/*.json", { eager: true, import: "default" }) as Record<
  string,
  Record<string, string>
>;

export const resources: Resource = {};

for (const [path, strings] of Object.entries(files)) {
  const language = /\/([a-z]{2,3})(?:\.[a-z]+)?\.json$/.exec(path)?.[1];
  if (!language) continue;
  const bundle = (resources[language] ??= { translation: {} });
  Object.assign(bundle.translation as Record<string, string>, strings);
}
