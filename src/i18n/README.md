# The interface's words

The interface is written in English and read in English or Turkish. This
directory is how: i18next with the English copy as the key, one Turkish
catalogue, and a locale decided per request so the server and the first
client render agree.

## Where things are

| File | What it is |
|---|---|
| `index.ts` | The instance, `createI18n`, `msg`, `lookup`, `englishT`, and the re-exported `useTranslation`/`Trans`. Import these from `@/i18n`, never from `react-i18next` — importing this module is what hands react-i18next its instance, and a component that reached for the package directly rendered raw keys in a unit test. |
| `locale.ts` | Pure: the cookie name, `pickLocale`, `uiLanguage`, `formattingLocale`, the Accept-Language parser. |
| `request-locale.ts` | What the root route's `beforeLoad` asks: cookie → Accept-Language → `en`, on the server and the client alike. |
| `provider.tsx` | `LocaleProvider` (a per-request clone on the server, the singleton on the client), `useLocale()` for `Intl`, `useHtmlLang()`, and `applyLocale()` which writes the cookie and switches the catalogue. |
| `resources.ts` | The only file that reads `locales/`. A glob, so the hosted tree can add `*.cloud.json` beside these. |
| `locales/en.json` | Written by `bun run i18n:extract`. Every value is its key. |
| `locales/tr.json` | The Turkish. The only file in the repository allowed to hold any. |
| `catalogue.static.test.ts` | en and tr agree: every English key has a Turkish value, no orphans, placeholders match, no suffix hung on a placeholder. |
| `migrated.static.test.ts` | A translated file stays translated: no inline toast words, no `=== 1 ? "x" : "xs"`, no `"en-GB"` left in a `toLocale…` call, no `toUpperCase()` without a locale. Its `MIGRATED` list is the same list `eslint.config.js` scopes `i18next/no-literal-string` to. |

## Writing a string

```tsx
import { useTranslation, Trans, msg, lookup } from "@/i18n";
import { useLocale } from "@/i18n/provider";

const { t } = useTranslation();
const locale = useLocale();

t("Save changes")                                   // the English is the key
t("Role for {{name}}", { name })                     // interpolation
t("{{count}} file", { count, defaultValue_other: "{{count}} files" })   // plural: singular key, plural default
t("Done", { context: "status", defaultValue: "Done" })                  // one English word, two translations
<Trans t={t} i18nKey="Sign in as <b>{{email}}</b>." values={{ email }}
       components={{ b: <strong /> }} />           // markup inside a sentence; named tags, never <1>
n.toLocaleString(locale); d.toLocaleDateString(locale, { … }); a.localeCompare(b, locale);
s.toLocaleUpperCase(locale)                         // a Turkish i has two capitals
```

- A table of strings (`PRIMARY_NAV`, `ROLE_SUMMARY`) stores keys with `msg("…")` and is drawn with
  `lookup(t, item.label)`. `t(variable)` is refused by the extraction tool, which needs to see the key.
- A pure helper in `src/lib` takes `t` and `locale` after `now`, with `englishT` and the region it was
  always formatted in as defaults, so a caller that has not been translated — and every existing test —
  reads as before.
- A `toUpperCase()` on something that is not a word (a hex id, a key name) is fine; say so with
  `// i18n-ignore` on that line or the comment above it.
- `{{count}}` is reserved for the plural selector. A number that does not pluralise the sentence gets
  another name.
- Route `head()` titles and the root meta are not translated yet.

Then `bun run i18n:extract`, add the Turkish for every new key to `tr.json`, and run `bun run test`.
CI runs `bun run i18n:check`, which fails when the committed catalogues are not what the source
would extract.

## Turkish

Formal *siz*; buttons are bare imperatives (Kaydet, Gönder). Sentence case; no trailing period on a
label, button or toast. Never hang a suffix on a placeholder — `{{name}}'ın` reads right for one name
and wrong for the next, and the catalogue test rejects `}}'`. Put the suffix on a noun after the
placeholder (`{{folder}} klasörüne`), use a postposition (`{{name}} için`), or a word before a number
(`saat {{time}}`). "Covan" never takes an apostrophe: "Covan hesabınız".

Glossary: agent = ajan · workspace = çalışma alanı · thread = konuşma · brainstorm = beyin fırtınası ·
Inbox = Gelen kutusu · Knowledge = Bilgi · folder = klasör · document = belge · file = dosya ·
routine = rutin · run = çalıştırma / Çalıştır · Team = Ekip · member = üye · admin = yönetici ·
viewer = görüntüleyici · credits = kredi · Settings = Ayarlar · Preferences = Tercihler ·
Integrations = Entegrasyonlar · Coverage = Kapsam · Done (status) = Tamamlandı · Done (button) = Bitti.

## How the language is chosen

1. The `covan-locale` cookie, which `applyLocale` writes when the preference is saved and whenever
   `/me` arrives with one — so a choice made on one device follows the account to the next.
2. Otherwise the first language in `Accept-Language` (or `navigator.languages`) that the interface
   has, region kept: an `en-US` browser formats dates its own way, a German one gets English.
3. Otherwise `en`.

The tag goes into `<html lang>` and every `Intl` call; `uiLanguage()` maps it to the catalogue. A bare
`en` formats as `en-GB`, which is how the interface has always written its dates.
