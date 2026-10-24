/**
 * The one line a settled reply's steps fold into (A2): "Searched Knowledge ·
 * 3 sources · 6 s". What it did, in the words of the first thing it did; how
 * many documents it came back with; how long it took, when the steps said.
 */

import { englishT, lookup, msg, type Translate } from "@/i18n";

/** What each tool did, as the start of a sentence. Keys; `stepVerb` says them. */
const DID: Record<string, string> = {
  search_documents: msg("Searched Knowledge"),
  read_pages: msg("Read through an app"),
  run_tool: msg("Used a connected app"),
  find_tool: msg("Looked for a tool"),
  describe_connection: msg("Looked at a connection"),
  browse: msg("Used the browser"),
  query_database: msg("Queried the database"),
  http_request: msg("Called an API"),
  send_email: msg("Sent an email"),
  write_document: msg("Wrote a document"),
  list_documents: msg("Looked through Knowledge"),
  read_document: msg("Read a document"),
  edit_document: msg("Edited a document"),
  covan_guide: msg("Checked the Covan guide"),
  schedule_job: msg("Scheduled a job"),
  run_routine: msg("Ran a routine"),
  watch_event: msg("Set up a watch"),
  ask_person: msg("Asked a question"),
};

export function stepVerb(tool: string, t: Translate = englishT): string {
  const key = DID[tool];
  return key ? lookup(t, key) : t("Used a tool");
}

/** "6 s", "0.4 s", "2 min 5 s". */
export function stepTime(ms: number, t: Translate = englishT, locale: string = "en"): string {
  if (ms < 1000) {
    const seconds = new Intl.NumberFormat(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(Math.max(ms, 100) / 1000);
    return t("{{seconds}} s", { seconds });
  }
  const s = Math.round(ms / 1000);
  if (s < 60) return t("{{seconds}} s", { seconds: s });
  const rest = s % 60;
  const minutes = Math.floor(s / 60);
  return rest === 0
    ? t("{{minutes}} min", { minutes })
    : t("{{minutes}} min {{seconds}} s", { minutes, seconds: rest });
}

export function stepsSummary(
  steps: Array<{ tool: string; status: string; durationMs?: number | null }>,
  sources = 0,
  t: Translate = englishT,
  locale: string = "en",
): string {
  if (steps.length === 0) return "";
  const verbs: string[] = [];
  for (const s of steps) {
    const v = stepVerb(s.tool, t);
    if (!verbs.includes(v)) verbs.push(v);
  }
  const did =
    verbs.length === 1
      ? verbs[0]!
      : verbs.length === 2
        ? t("{{first}} and {{second}}", {
            first: verbs[0],
            second: `${verbs[1]!.charAt(0).toLocaleLowerCase(locale)}${verbs[1]!.slice(1)}`,
          })
        : t("{{first}} and {{count}} more step", {
            first: verbs[0],
            count: steps.length - 1,
            defaultValue_other: "{{first}} and {{count}} more steps",
          });

  const timed = steps.filter((s) => typeof s.durationMs === "number");
  const took =
    timed.length > 0
      ? stepTime(
          timed.reduce((n, s) => n + (s.durationMs ?? 0), 0),
          t,
          locale,
        )
      : null;
  const failed = steps.filter((s) => s.status === "failed" || s.status === "refused").length;

  return [
    did,
    sources > 0
      ? t("{{count}} source", { count: sources, defaultValue_other: "{{count}} sources" })
      : null,
    took,
    failed > 0
      ? t("{{count}} did not complete", {
          count: failed,
          defaultValue_other: "{{count}} did not complete",
        })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
