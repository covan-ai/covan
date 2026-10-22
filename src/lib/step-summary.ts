/**
 * The one line a settled reply's steps fold into (A2): "Searched Knowledge ·
 * 3 sources · 6 s". What it did, in the words of the first thing it did; how
 * many documents it came back with; how long it took, when the steps said.
 */

/** What each tool did, as the start of a sentence. */
const DID: Record<string, string> = {
  search_documents: "Searched Knowledge",
  read_pages: "Read through an app",
  run_tool: "Used a connected app",
  find_tool: "Looked for a tool",
  describe_connection: "Looked at a connection",
  browse: "Used the browser",
  query_database: "Queried the database",
  http_request: "Called an API",
  send_email: "Sent an email",
  write_document: "Wrote a document",
  schedule_job: "Scheduled a job",
  run_routine: "Ran a routine",
  watch_event: "Set up a watch",
  ask_person: "Asked a question",
};

export function stepVerb(tool: string): string {
  return DID[tool] ?? "Used a tool";
}

/** "6 s", "0.4 s", "2 min 5 s". */
export function stepTime(ms: number): string {
  if (ms < 1000) return `${(Math.max(ms, 100) / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const rest = s % 60;
  return rest === 0 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 60)} min ${rest} s`;
}

export function stepsSummary(
  steps: Array<{ tool: string; status: string; durationMs?: number | null }>,
  sources = 0,
): string {
  if (steps.length === 0) return "";
  const verbs: string[] = [];
  for (const s of steps) {
    const v = stepVerb(s.tool);
    if (!verbs.includes(v)) verbs.push(v);
  }
  const did =
    verbs.length === 1
      ? verbs[0]!
      : verbs.length === 2
        ? `${verbs[0]} and ${verbs[1]!.charAt(0).toLowerCase()}${verbs[1]!.slice(1)}`
        : `${verbs[0]} and ${steps.length - 1} more steps`;

  const timed = steps.filter((s) => typeof s.durationMs === "number");
  const took =
    timed.length > 0 ? stepTime(timed.reduce((n, s) => n + (s.durationMs ?? 0), 0)) : null;
  const failed = steps.filter((s) => s.status === "failed" || s.status === "refused").length;

  return [
    did,
    sources > 0 ? `${sources} ${sources === 1 ? "source" : "sources"}` : null,
    took,
    failed > 0 ? `${failed} did not complete` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
