import { emailShell } from "../email-layout";
import { escapeHtml } from "../escape-html";
import { paragraphs } from "./prose";

const PREFERENCES = "Settings › Preferences";

/**
 * "An agent needs me and I have been away for an hour" (A16). Sent once per
 * thing waiting, to the person it waits on, about their own thread.
 */
export function needsYouEmail(args: {
  email: string;
  kind: "approval" | "question";
  agentName: string;
  workspaceName: string;
  title: string;
  summary: string | null;
  url: string;
}) {
  const what =
    args.kind === "question"
      ? `${args.agentName} asked you something in “${args.title}”`
      : `${args.agentName} wants your go-ahead in “${args.title}”`;
  const detail = args.summary?.trim()
    ? args.kind === "question"
      ? `“${args.summary.trim()}”`
      : `It wants to: ${args.summary.trim()}`
    : null;
  return {
    to: args.email,
    subject: `${args.agentName} is waiting on you in ${args.workspaceName}`,
    text: [
      `${what}, and has been waiting since.`,
      ...(detail ? ["", detail] : []),
      "",
      `Open the thread: ${args.url}`,
      "",
      `You get this because you were away from Covan for an hour. Turn it off in ${PREFERENCES}.`,
    ].join("\n"),
    html: emailShell({
      preheader: detail ?? what,
      heading: `${args.agentName} is waiting on you`,
      bodyHtml: paragraphs(
        `${escapeHtml(what)}, and has been waiting since.`,
        ...(detail ? [escapeHtml(detail)] : []),
      ),
      action: { label: "Open the thread", url: args.url },
      footnote: `You get this because you were away from Covan for an hour. Turn it off in ${PREFERENCES}.`,
    }),
  };
}

/**
 * "A routine fails" (A16). Sent on the first failure in a row, so a routine
 * that keeps failing is one email, not one per run; a run that works again
 * starts the count over.
 */
export function routineFailedEmail(args: {
  email: string;
  routineName: string;
  error: string;
  url: string;
}) {
  const reason = args.error.trim().slice(0, 500) || "something went wrong";
  return {
    to: args.email,
    subject: `“${args.routineName}” failed`,
    text: [
      `The last run of “${args.routineName}” failed: ${reason}`,
      "",
      "It will try again at its next time. If it keeps failing it pauses itself and says so.",
      "",
      `Open the routine: ${args.url}`,
      "",
      `Turn these emails off in ${PREFERENCES}.`,
    ].join("\n"),
    html: emailShell({
      preheader: reason,
      heading: `“${args.routineName}” failed`,
      bodyHtml: paragraphs(
        `The last run of “${escapeHtml(args.routineName)}” failed: ${escapeHtml(reason)}`,
        "It will try again at its next time. If it keeps failing it pauses itself and says so.",
      ),
      action: { label: "Open the routine", url: args.url },
      footnote: `Turn these emails off in ${PREFERENCES}.`,
    }),
  };
}

export type WeeklyPersonal = {
  threads: number;
  needsYou: number;
  runsDone: number;
  runsFailed: number;
};

export type WeeklyUsage = {
  unit: "credits" | "usd";
  total: number;
  byAgent: Array<{ name: string; threads: number; amount: number }>;
};

function amountWords(amount: number, unit: WeeklyUsage["unit"]): string {
  return unit === "credits" ? `${amount.toLocaleString("en-US")} credits` : `$${amount.toFixed(2)}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/**
 * Monday morning: a person's own week (A16's "Weekly summary") and, for an
 * admin of a workspace that asked for it, credits and threads per agent (A9's
 * "Weekly usage summary"). One email with whichever of the two applies.
 */
export function weeklySummaryEmail(args: {
  email: string;
  workspaceName: string;
  weekOf: string;
  personal: WeeklyPersonal | null;
  usage: WeeklyUsage | null;
  url: string;
}) {
  const lines: string[] = [];
  const html: string[] = [];
  if (args.personal) {
    const p = args.personal;
    const sentence =
      `Last week you had ${plural(p.threads, "thread", "threads")}; ` +
      `${plural(p.needsYou, "thing is", "things are")} waiting on you now. ` +
      `Routines ran ${plural(p.runsDone + p.runsFailed, "time", "times")}` +
      (p.runsFailed > 0 ? `, and ${plural(p.runsFailed, "run", "runs")} failed.` : ".");
    lines.push(sentence);
    html.push(escapeHtml(sentence));
  }
  if (args.usage) {
    const u = args.usage;
    const head = `The workspace used ${amountWords(u.total, u.unit)} last week.`;
    const rows = u.byAgent.map(
      (a) =>
        `${a.name}: ${plural(a.threads, "thread", "threads")}, ${amountWords(a.amount, u.unit)}`,
    );
    lines.push("", head, ...rows);
    html.push(escapeHtml(head), rows.map(escapeHtml).join("<br>"));
  }
  return {
    to: args.email,
    subject: `Your week in ${args.workspaceName}`,
    text: [
      ...lines,
      "",
      `Open Covan: ${args.url}`,
      "",
      `Turn this off in ${PREFERENCES}${args.usage ? " or, for the usage part, Settings › General" : ""}.`,
    ].join("\n"),
    html: emailShell({
      preheader: lines[0] ?? `The week of ${args.weekOf}.`,
      heading: `Your week in ${args.workspaceName}`,
      bodyHtml: paragraphs(...html),
      action: { label: "Open Covan", url: args.url },
      footnote: `Turn this off in ${PREFERENCES}${args.usage ? " or, for the usage part, Settings › General" : ""}.`,
    }),
  };
}
