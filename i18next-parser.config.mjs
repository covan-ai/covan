// What `bun run i18n:extract` reads. It walks the source for `t("…")`,
// `msg("…")` and `<Trans>`, and writes every key it finds into
// src/i18n/locales/en.json (value: the key, since the key is the English)
// and tr.json (value kept if there is one, "" if not — which the catalogue
// test then refuses, so a new string cannot ship without its Turkish).
//
// `bun run i18n:check` runs the same with --fail-on-update: CI's way of
// saying the committed catalogues match the source.
//
// The hosted tree has pages this one does not. It adds a second config
// beside this one that lists them, and this file — identical in both trees
// — leaves those files to it.
const cloud = await import("./i18next-parser.cloud.config.mjs").catch(() => null);

export default {
  locales: ["en", "tr"],
  input: [
    "src/**/*.{ts,tsx}",
    "!src/**/*.test.{ts,tsx}",
    "!src/routeTree.gen.ts",
    "!src/i18n/**",
    "!src/test/**",
    ...(cloud?.default?.excludeFromShared ?? []),
  ],
  output: "src/i18n/locales/$LOCALE.json",
  keySeparator: false,
  namespaceSeparator: false,
  pluralSeparator: "_",
  contextSeparator: "_",
  // English is the key. A plural's `_other` and a context key's text come
  // from the call's own defaultValue; everything else is the key verbatim.
  defaultValue: (locale, _namespace, key, value) => (locale === "en" ? value || key : ""),
  keepRemoved: false,
  createOldCatalogs: false,
  sort: true,
  indentation: 2,
  lineEnding: "lf",
  lexers: {
    ts: [{ lexer: "JavascriptLexer", functions: ["t", "msg"] }],
    tsx: [{ lexer: "JsxLexer", functions: ["t", "msg"] }],
  },
  failOnWarnings: true,
};
