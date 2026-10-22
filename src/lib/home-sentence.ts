/**
 * The words at the top of Home (Main, A24): the greeting, the date, and one
 * sentence that says what needs you, what is running and what the week cost.
 *
 * Pure, so the clock and the zone are arguments: the profile's time zone when
 * it has one, else whatever the browser is in.
 */

const NUMBER_WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

/** "three" up to twelve, then digits: "48". */
export function countWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length
    ? NUMBER_WORDS[n]!
    : n.toLocaleString("en-US");
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A zone the browser knows, or undefined so `Intl` uses its own. */
function knownZone(timeZone: string | null | undefined): string | undefined {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

/** "Wednesday, 22 October". */
export function homeDate(now: Date, timeZone?: string | null): string {
  const zone = knownZone(timeZone);
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: zone }).format(now);
  const date = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: zone,
  }).format(now);
  return `${weekday}, ${date}`;
}

/** "Good morning, Mina." — the first name only, and "there" without one. */
export function greeting(now: Date, name: string | null | undefined, timeZone?: string | null) {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: knownZone(timeZone),
    }).format(now),
  );
  const part =
    hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 18 ? "afternoon" : "evening";
  return `Good ${part}, ${firstName(name)}.`;
}

export function firstName(name: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] || "there";
}

export type SpendUnit = "credits" | "usd";

/** The figure alone, for a stat: "612", "$4.12". */
export function amountValue(amount: number, unit: SpendUnit): string {
  return unit === "usd"
    ? `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : amount.toLocaleString("en-US");
}

/** The figure in a sentence: "612 credits", "1 credit", "$4.12". */
export function amountWords(amount: number, unit: SpendUnit): string {
  if (unit === "usd") return amountValue(amount, unit);
  return `${amount.toLocaleString("en-US")} ${amount === 1 ? "credit" : "credits"}`;
}

/** A thread's title inside a sentence, without the stop it may end on. */
function inSentence(title: string): string {
  return title.trim().replace(/[.!?…]+$/, "");
}

export type HomeSentenceInput = {
  now: Date;
  timeZone?: string | null;
  needsYou: number;
  /** Agents with a turn or a routine under way, and what it is, when the caller may read it. */
  running: Array<{ agent: string; title: string | null }>;
  /** Left out for anybody who is not shown what the workspace spends. */
  spend?: { amount: number; unit: SpendUnit; days: number } | null;
};

/**
 * "Wednesday, 22 October. Three things need you, Research is working on
 * Weekly competitor brief, and the team has spent 612 credits in the last
 * seven days."
 */
export function homeSentence({ now, timeZone, needsYou, running, spend }: HomeSentenceInput) {
  const clauses: string[] = [
    needsYou === 0
      ? "nothing needs you"
      : `${countWord(needsYou)} ${needsYou === 1 ? "thing needs" : "things need"} you`,
  ];
  if (running.length === 1) {
    const only = running[0]!;
    clauses.push(
      only.title
        ? `${only.agent} is working on ${inSentence(only.title)}`
        : `${only.agent} is working`,
    );
  } else if (running.length === 2) {
    clauses.push(`${running[0]!.agent} and ${running[1]!.agent} are working`);
  } else if (running.length > 2) {
    clauses.push(`${countWord(running.length)} agents are working`);
  }
  if (spend && spend.amount > 0) {
    const days = spend.days === 1 ? "day" : `${countWord(spend.days)} days`;
    clauses.push(`the team has spent ${amountWords(spend.amount, spend.unit)} in the last ${days}`);
  }
  const body =
    clauses.length === 1
      ? clauses[0]!
      : `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
  return `${homeDate(now, timeZone)}. ${capitalise(body)}.`;
}

/**
 * The line under Spend by agent: the agent whose week went up the most, when
 * it went up by a quarter or more on a week that had any spend at all.
 * Nothing when no agent's did — a sentence is not owed every week.
 */
export function spendNote(
  daily: Array<{ byAgent: Record<string, number> }>,
  nameOf: (agentId: string) => string | undefined,
  unit: SpendUnit,
  windowDays = 7,
): string | null {
  const current = new Map<string, number>();
  const previous = new Map<string, number>();
  daily.forEach((day, i) => {
    const into =
      i >= daily.length - windowDays
        ? current
        : i >= daily.length - 2 * windowDays
          ? previous
          : null;
    if (!into) return;
    for (const [agentId, amount] of Object.entries(day.byAgent)) {
      into.set(agentId, (into.get(agentId) ?? 0) + amount);
    }
  });
  let best: { agentId: string; now: number; before: number } | null = null;
  for (const [agentId, now] of current) {
    const before = previous.get(agentId) ?? 0;
    if (before <= 0 || now < before * 1.25) continue;
    if (!best || now - before > best.now - best.before) best = { agentId, now, before };
  }
  if (!best) return null;
  const name = nameOf(best.agentId);
  if (!name) return null;
  const round = (n: number) => (unit === "usd" ? Math.round(n * 100) / 100 : Math.round(n));
  return `${name} is up this week: ${amountWords(round(best.now), unit)} against ${amountValue(round(best.before), unit)} the week before.`;
}

/** "12 min ago", "3 h ago", "10:00" earlier today, "Yesterday", "Mon", "12 Oct". */
export function feedTime(at: number, now: number = Date.now()): string {
  const MINUTE = 60_000;
  const ago = now - at;
  if (ago < MINUTE) return "just now";
  if (ago < 60 * MINUTE) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago < 6 * 60 * MINUTE) return `${Math.floor(ago / (60 * MINUTE))} h ago`;
  const d = new Date(at);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (at >= today.getTime()) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  if (at >= today.getTime() - 24 * 60 * MINUTE) return "Yesterday";
  if (at >= today.getTime() - 6 * 24 * 60 * MINUTE) {
    return d.toLocaleDateString("en-GB", { weekday: "short" });
  }
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** The same moment inside a sentence: "12 min ago", "at 10:00", "yesterday". */
function sinceWords(at: number, now: number): string {
  const t = feedTime(at, now);
  if (/^\d{2}:\d{2}$/.test(t)) return `at ${t}`;
  if (/ago$|^just now$/.test(t)) return t;
  if (t === "Yesterday") return "yesterday";
  return `on ${t}`;
}

export type WorkingOn = {
  kind: "running" | "question" | "approval" | "login" | "routine_failed" | "last";
  stepsDone?: number;
  note?: string | null;
  since: number;
};

/**
 * What follows the thread's title in Right now (Main): "step 3, reading 6
 * pages", "asked you a question 12 min ago", "waiting for your approval".
 */
export function workingOnDetail(w: WorkingOn, now: number = Date.now()): string {
  switch (w.kind) {
    case "running":
      if (w.stepsDone) return `step ${w.stepsDone}${w.note ? `, ${w.note}` : ""}`;
      return w.note ?? `started ${sinceWords(w.since, now)}`;
    case "question":
      return `asked you a question ${sinceWords(w.since, now)}`;
    case "approval":
      return "waiting for your approval";
    case "login":
      return "needs you to sign in";
    case "routine_failed":
      return `failed ${sinceWords(w.since, now)}`;
    case "last":
      return sinceWords(w.since, now);
  }
}

export type FeedItem = {
  action: string;
  subjectLabel: string;
  count: number;
  detail: Record<string, unknown> | null;
};

/**
 * One row of Recent activity after the actor's name, split so the subject
 * can be a link: "shared · Cancellation flow questions · with the team".
 */
export function activityLine(item: FeedItem): { before: string; subject: string; after: string } {
  const label = item.subjectLabel;
  switch (item.action) {
    case "session.shared":
      return { before: "shared", subject: label, after: "with the team" };
    case "turn.approved":
      return { before: "approved", subject: label, after: "" };
    case "routine.run_finished":
      return { before: "finished", subject: label, after: "" };
    case "routine.run_failed":
      return { before: "could not finish", subject: label, after: "" };
    case "document.added": {
      const folder =
        typeof item.detail?.bundle_name === "string" && item.detail.bundle_name
          ? `Knowledge / ${item.detail.bundle_name}`
          : "Knowledge";
      return item.count > 1
        ? { before: `added ${item.count} files to`, subject: folder, after: "" }
        : { before: "added", subject: label, after: `to ${folder}` };
    }
    default:
      return { before: "", subject: label, after: "" };
  }
}

/** "2 questions, 1 approval" — the parts of Needs you that are there. */
export function needsYouParts(n: { questions: number; approvals: number; other: number }): string {
  const parts: string[] = [];
  if (n.questions) parts.push(`${n.questions} ${n.questions === 1 ? "question" : "questions"}`);
  if (n.approvals) parts.push(`${n.approvals} ${n.approvals === 1 ? "approval" : "approvals"}`);
  if (n.other) parts.push(`${n.other} more`);
  return parts.join(", ");
}

/** "+12 vs the week before", "−3 vs the week before", "Same as the week before". */
export function weekDelta(now: number, before: number): string {
  const d = now - before;
  if (d === 0) return "Same as the week before";
  return `${d > 0 ? "+" : "−"}${Math.abs(d).toLocaleString("en-US")} vs the week before`;
}
