/**
 * A routine form, parked across a connect round trip.
 *
 * Starting from a use case that needs an app somebody has not connected, the
 * editor offers Connect beside the app. Connecting leaves the page for the
 * app's consent screen and comes back to `/routines/new?template=…`, which
 * would otherwise open on the template again and lose whatever the person had
 * changed. So the form is parked here first, in this tab's session storage,
 * and the editor reads it back once.
 *
 * Read once, like the pending grant (`sensitive-url.ts`): taking it removes
 * it, so a reload or a later visit starts from the template. Only for the same
 * page and template it was parked for, and only for half an hour — a draft
 * found the next morning is not the one somebody is coming back to.
 */
const KEY = "covan.routine-draft";

/** How long a parked draft is worth coming back to. */
export const PARK_FOR_MS = 30 * 60_000;

/** Everything the editor needs to put the form back as it was. */
export type ParkedDraft = {
  agentId: string;
  name: string;
  runs: string;
  connectionId: string;
  cron: string;
  timezone: string;
  instruction: string;
  fileTo: string | null;
  emailIds: string[] | null;
  slackId: string | null | undefined;
  inbox: boolean;
  model: string | null;
  effort: string | null;
  /** The connections a "don't ask again" switch was turned off for. */
  allowOff: string[];
  browserOn: boolean;
};

type Stored = { path: string; templateId: string; at: number; draft: ParkedDraft };

/** Park the form for the page it will come back to. */
export function parkDraft(
  path: string,
  templateId: string,
  draft: ParkedDraft,
  now = Date.now(),
): void {
  try {
    const stored: Stored = { path, templateId, at: now, draft };
    sessionStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Storage blocked: the person comes back to the template, which is what
    // happened before this existed.
  }
}

/**
 * The parked form for this page and template, or null, without removing it.
 * For a `useState` initialiser, which may run twice; `forgetParkedDraft` in an
 * effect is what makes it read once.
 */
export function readParkedDraft(
  path: string,
  templateId: string,
  now = Date.now(),
): ParkedDraft | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Stored;
    if (stored.path !== path || stored.templateId !== templateId) return null;
    if (typeof stored.at !== "number" || now - stored.at > PARK_FOR_MS) return null;
    return stored.draft ?? null;
  } catch {
    return null;
  }
}

/** Remove whatever is parked. */
export function forgetParkedDraft(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to forget, or nowhere to forget it from.
  }
}

/** Read and remove: the parked form for this page and template, at most once. */
export function takeParkedDraft(
  path: string,
  templateId: string,
  now = Date.now(),
): ParkedDraft | null {
  const draft = readParkedDraft(path, templateId, now);
  forgetParkedDraft();
  return draft;
}
