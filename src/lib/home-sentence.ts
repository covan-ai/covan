import { englishT, lookup, msg, type Translate } from "@/i18n";

/**
 * The words at the top of Home (Main, A24): the greeting, the date, and one
 * sentence that says what needs you, what is running and what the week cost.
 *
 * Pure, so the clock and the zone are arguments: the profile's time zone when
 * it has one, else whatever the browser is in. `t` and `locale` the same way,
 * defaulting to the English and the region it has always been written in.
 */

const EN = "en-GB";

/**
 * The numbers the sentence spells out, as keys, so the translation can spell
 * them out too. "no" is a count here, never an answer; an answer would be
 * capitalised and its own key.
 */
const NUMBER_WORDS = [
  msg("no"),
  msg("one"),
  msg("two"),
  msg("three"),
  msg("four"),
  msg("five"),
  msg("six"),
  msg("seven"),
  msg("eight"),
  msg("nine"),
  msg("ten"),
  msg("eleven"),
  msg("twelve"),
];

/** "three" up to twelve, then digits: "48". */
export function countWord(n: number, t: Translate = englishT, locale: string = EN): string {
  const word = Number.isInteger(n) && n >= 0 ? NUMBER_WORDS[n] : undefined;
  return word ? lookup(t, word) : n.toLocaleString(locale);
}

function capitalise(s: string, locale: string): string {
  return s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);
}

/** A zone the browser knows, or undefined so `Intl` uses its own. */
function knownZone(timeZone: string | null | undefined): string | undefined {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat(EN, { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

/** "Wednesday, 22 October". */
export function homeDate(now: Date, timeZone?: string | null, locale: string = EN): string {
  const zone = knownZone(timeZone);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: zone }).format(now);
  const date = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    timeZone: zone,
  }).format(now);
  return `${weekday}, ${date}`;
}

/** "Good morning, Mina." — the first name only, and "there" without one. */
export function greeting(
  now: Date,
  name: string | null | undefined,
  timeZone?: string | null,
  t: Translate = englishT,
): string {
  const hour = Number(
    new Intl.DateTimeFormat(EN, {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: knownZone(timeZone),
    }).format(now),
  );
  const first = firstName(name);
  // Separate keys with and without a name: "Good morning, there." has no
  // Turkish, where the greeting simply stands alone.
  if (hour >= 5 && hour < 12) {
    return first ? t("Good morning, {{name}}.", { name: first }) : t("Good morning, there.");
  }
  if (hour >= 12 && hour < 18) {
    return first ? t("Good afternoon, {{name}}.", { name: first }) : t("Good afternoon, there.");
  }
  return first ? t("Good evening, {{name}}.", { name: first }) : t("Good evening, there.");
}

/** The first word of a name, or nothing. */
export function firstName(name: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] || "";
}

export type SpendUnit = "credits" | "usd";

/** The figure alone, for a stat: "612", "$4.12". */
export function amountValue(amount: number, unit: SpendUnit, locale: string = "en-US"): string {
  return unit === "usd"
    ? amount.toLocaleString(locale, { style: "currency", currency: "USD" })
    : amount.toLocaleString(locale);
}

/** The figure in a sentence: "612 credits", "1 credit", "$4.12". */
export function amountWords(
  amount: number,
  unit: SpendUnit,
  t: Translate = englishT,
  locale: string = "en-US",
): string {
  if (unit === "usd") return amountValue(amount, unit, locale);
  return t("{{amount}} credit", {
    count: amount,
    amount: amount.toLocaleString(locale),
    defaultValue_other: "{{amount}} credits",
  });
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
  t?: Translate;
  locale?: string;
};

/**
 * "Wednesday, 22 October. Three things need you, Research is working on
 * Weekly competitor brief, and the team has spent 612 credits in the last
 * seven days."
 */
export function homeSentence({
  now,
  timeZone,
  needsYou,
  running,
  spend,
  t = englishT,
  locale = EN,
}: HomeSentenceInput): string {
  const clauses: string[] = [
    needsYou === 0
      ? t("nothing needs you")
      : t("{{n}} thing needs you", {
          count: needsYou,
          n: countWord(needsYou, t, locale),
          defaultValue_other: "{{n}} things need you",
        }),
  ];
  if (running.length === 1) {
    const only = running[0]!;
    clauses.push(
      only.title
        ? t("{{agent}} is working on {{title}}", {
            agent: only.agent,
            title: inSentence(only.title),
          })
        : t("{{agent}} is working", { agent: only.agent }),
    );
  } else if (running.length === 2) {
    clauses.push(
      t("{{first}} and {{second}} are working", {
        first: running[0]!.agent,
        second: running[1]!.agent,
      }),
    );
  } else if (running.length > 2) {
    clauses.push(t("{{n}} agents are working", { n: countWord(running.length, t, locale) }));
  }
  if (spend && spend.amount > 0) {
    const days =
      spend.days === 1 ? t("day") : t("{{n}} days", { n: countWord(spend.days, t, locale) });
    clauses.push(
      t("the team has spent {{amount}} in the last {{days}}", {
        amount: amountWords(spend.amount, spend.unit, t, locale === EN ? "en-US" : locale),
        days,
      }),
    );
  }
  const body =
    clauses.length === 1
      ? clauses[0]!
      : t("{{rest}}, and {{last}}", {
          rest: clauses.slice(0, -1).join(", "),
          last: clauses[clauses.length - 1],
        });
  return `${homeDate(now, timeZone, locale)}. ${capitalise(body, locale)}.`;
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
  t: Translate = englishT,
  locale: string = "en-US",
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
  return t("{{name}} is up this week: {{now}} against {{before}} the week before.", {
    name,
    now: amountWords(round(best.now), unit, t, locale),
    before: amountValue(round(best.before), unit, locale),
  });
}

/**
 * A moment in the feed, sorted before it is worded, so the sentence helpers
 * below can pick a key by what it is rather than by reading the output.
 */
type FeedMoment =
  | { kind: "just-now" }
  | { kind: "minutes"; n: number }
  | { kind: "hours"; n: number }
  | { kind: "clock"; text: string }
  | { kind: "yesterday" }
  | { kind: "weekday"; text: string }
  | { kind: "date"; text: string };

function feedMoment(at: number, now: number, locale: string): FeedMoment {
  const MINUTE = 60_000;
  const ago = now - at;
  if (ago < MINUTE) return { kind: "just-now" };
  if (ago < 60 * MINUTE) return { kind: "minutes", n: Math.floor(ago / MINUTE) };
  if (ago < 6 * 60 * MINUTE) return { kind: "hours", n: Math.floor(ago / (60 * MINUTE)) };
  const d = new Date(at);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (at >= today.getTime()) {
    return {
      kind: "clock",
      text: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
    };
  }
  if (at >= today.getTime() - 24 * 60 * MINUTE) return { kind: "yesterday" };
  if (at >= today.getTime() - 6 * 24 * 60 * MINUTE) {
    return { kind: "weekday", text: d.toLocaleDateString(locale, { weekday: "short" }) };
  }
  return { kind: "date", text: d.toLocaleDateString(locale, { day: "numeric", month: "short" }) };
}

/** "12 min ago", "3 h ago", "10:00" earlier today, "Yesterday", "Mon", "12 Oct". */
export function feedTime(
  at: number,
  now: number = Date.now(),
  t: Translate = englishT,
  locale: string = EN,
): string {
  const m = feedMoment(at, now, locale);
  switch (m.kind) {
    case "just-now":
      return t("just now");
    case "minutes":
      return t("{{count}} min ago", { count: m.n, defaultValue_other: "{{count}} min ago" });
    case "hours":
      return t("{{count}} h ago", { count: m.n, defaultValue_other: "{{count}} h ago" });
    case "clock":
      return m.text;
    case "yesterday":
      return t("Yesterday");
    default:
      return m.text;
  }
}

/** The same moment inside a sentence: "12 min ago", "at 10:00", "yesterday". */
function sinceWords(at: number, now: number, t: Translate, locale: string): string {
  const m = feedMoment(at, now, locale);
  switch (m.kind) {
    case "clock":
      return t("at {{time}}", { time: m.text });
    case "yesterday":
      return t("yesterday");
    case "weekday":
    case "date":
      return t("on {{day}}", { day: m.text });
    default:
      return feedTime(at, now, t, locale);
  }
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
export function workingOnDetail(
  w: WorkingOn,
  now: number = Date.now(),
  t: Translate = englishT,
  locale: string = EN,
): string {
  switch (w.kind) {
    case "running":
      if (w.stepsDone) {
        return w.note
          ? t("step {{step}}, {{note}}", { step: w.stepsDone, note: w.note })
          : t("step {{step}}", { step: w.stepsDone });
      }
      return w.note ?? t("started {{when}}", { when: sinceWords(w.since, now, t, locale) });
    case "question":
      return t("asked you a question {{when}}", { when: sinceWords(w.since, now, t, locale) });
    case "approval":
      return t("waiting for your approval");
    case "login":
      return t("needs you to sign in");
    case "routine_failed":
      return t("failed {{when}}", { when: sinceWords(w.since, now, t, locale) });
    case "last":
      return sinceWords(w.since, now, t, locale);
  }
}

export type FeedItem = {
  action: string;
  subjectLabel: string;
  count: number;
  detail: Record<string, unknown> | null;
};

/**
 * One row of Recent activity after the actor's name: a sentence with the
 * subject marked `<s>…</s>` so the caller can draw it as a link — with
 * `<Trans i18nKey={line.key} values={line.values} components={{ s: <Link/> }}>`.
 * A key rather than words, because where the subject sits in the sentence
 * is the translation's to decide.
 */
export type ActivityLine = {
  key: string;
  values: { subject: string; count?: number; folder?: string };
};

export function activityLine(item: FeedItem): ActivityLine {
  const subject = item.subjectLabel;
  switch (item.action) {
    case "session.shared":
      return { key: msg("shared <s>{{subject}}</s> with the team"), values: { subject } };
    case "turn.approved":
      return { key: msg("approved <s>{{subject}}</s>"), values: { subject } };
    case "routine.run_finished":
      return { key: msg("finished <s>{{subject}}</s>"), values: { subject } };
    case "routine.run_failed":
      return { key: msg("could not finish <s>{{subject}}</s>"), values: { subject } };
    case "document.added": {
      const folder =
        typeof item.detail?.bundle_name === "string" && item.detail.bundle_name
          ? `Knowledge / ${item.detail.bundle_name}`
          : "Knowledge";
      return item.count > 1
        ? {
            key: msg("added {{count}} files to <s>{{subject}}</s>"),
            values: { subject: folder, count: item.count },
          }
        : { key: msg("added <s>{{subject}}</s> to {{folder}}"), values: { subject, folder } };
    }
    default:
      return { key: msg("<s>{{subject}}</s>"), values: { subject } };
  }
}

/** "2 questions, 1 approval" — the parts of Needs you that are there. */
export function needsYouParts(
  n: { questions: number; approvals: number; other: number },
  t: Translate = englishT,
): string {
  const parts: string[] = [];
  if (n.questions) {
    parts.push(
      t("{{count}} question", { count: n.questions, defaultValue_other: "{{count}} questions" }),
    );
  }
  if (n.approvals) {
    parts.push(
      t("{{count}} approval", { count: n.approvals, defaultValue_other: "{{count}} approvals" }),
    );
  }
  if (n.other)
    parts.push(t("{{count}} more", { count: n.other, defaultValue_other: "{{count}} more" }));
  return parts.join(", ");
}

/** "+12 vs the week before", "−3 vs the week before", "Same as the week before". */
export function weekDelta(
  now: number,
  before: number,
  t: Translate = englishT,
  locale: string = "en-US",
): string {
  const d = now - before;
  if (d === 0) return t("Same as the week before");
  const delta = `${d > 0 ? "+" : "−"}${Math.abs(d).toLocaleString(locale)}`;
  return t("{{delta}} vs the week before", { delta });
}
