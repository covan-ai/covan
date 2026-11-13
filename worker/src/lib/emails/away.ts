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

/**
 * The arguments of a request, as a few short lines a person can read in a
 * mail client: what the card's rows show, flattened. `kind` and the catalogue
 * row `run_tool` carries for itself are left out, as the card leaves them out.
 */
export function proposalLines(proposal: unknown, max = 6): string[] {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(proposal as Record<string, unknown>)) {
    if (key === "kind" || key === "operation" || key === "does") continue;
    if (value === null || value === undefined || value === "") continue;
    let shown: string;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      shown = String(value);
    } else if (typeof value === "object" && !Array.isArray(value) && "label" in value) {
      shown = String((value as { label: unknown }).label);
    } else {
      shown = JSON.stringify(value);
    }
    shown = shown.replace(/\s+/g, " ").trim();
    lines.push(`${key}: ${shown.length > 200 ? `${shown.slice(0, 200)}…` : shown}`);
    if (lines.length >= max) break;
  }
  return lines;
}

/**
 * An agent asked for a go-ahead while nobody was watching (0144). Sent the
 * moment it asks, to the person it runs as, because the request waits a day
 * and the routine does nothing until somebody answers.
 *
 * The link opens the request's own page, which is where the buttons are:
 * opening the link changes nothing, and answering needs a signed-in session.
 */
export function approvalRequestEmail(args: {
  email: string;
  agentName: string;
  workspaceName: string;
  /** The routine whose run asked, or null for a conversation the agent came back to. */
  routineName: string | null;
  summary: string;
  proposal: unknown;
  expiresAt: Date;
  url: string;
  /**
   * Where a reply goes when answering by reply is on (0147): an address that
   * names this request. Absent where inbound mail is off, or the owner turned
   * it off, and then the email says nothing about replying.
   */
  replyTo?: string;
}) {
  const where = args.routineName
    ? `running your routine “${args.routineName}”`
    : "coming back to a conversation of yours";
  const what = `${args.agentName}, ${where}, wants your go-ahead before it does this:`;
  const summary = args.summary.trim() || "an action that changes something";
  const details = proposalLines(args.proposal);
  const until = `${args.expiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const wait = `Nothing happens until you answer. If nobody answers by ${until}, it is not done.`;
  // Said where the person decides whether to reply: a reply is as strong as
  // their mailbox, which anybody who can send as them also holds.
  const byReply = args.replyTo
    ? `You can also reply “yes” or “no” to this email. Anyone who can send mail as you can answer it that way; turn that off in ${PREFERENCES}.`
    : null;
  const footnote = [
    byReply,
    `You get this because an agent of yours asked while nobody was watching. Turn it off in ${PREFERENCES}.`,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    to: args.email,
    subject: `${args.agentName} is waiting for your go-ahead in ${args.workspaceName}`,
    ...(args.replyTo ? { replyTo: args.replyTo } : {}),
    headers: { "Auto-Submitted": "auto-generated" },
    text: [
      what,
      "",
      summary,
      ...(details.length > 0 ? ["", ...details] : []),
      "",
      wait,
      "",
      `Approve or decline: ${args.url}`,
      "",
      footnote,
    ].join("\n"),
    html: emailShell({
      preheader: summary,
      heading: `${args.agentName} is waiting for your go-ahead`,
      bodyHtml: paragraphs(
        escapeHtml(what),
        `<strong>${escapeHtml(summary)}</strong>`,
        ...(details.length > 0 ? [details.map(escapeHtml).join("<br>")] : []),
        escapeHtml(wait),
      ),
      action: { label: "Approve or decline", url: args.url },
      footnote,
    }),
  };
}

/**
 * A reply to a request email that did not answer it (0147), to the owner's own
 * address and nobody else's: why, and the link that does.
 */
export function approvalReplyNotTakenEmail(args: {
  email: string;
  reason: "unclear" | "unverified" | "off" | "already" | "expired";
  url: string;
}) {
  const why = {
    unclear:
      "We could not tell whether your reply meant yes or no. Reply with just “yes” or “no”, or use the link.",
    unverified:
      "Your reply could not be verified as coming from your address (its domain did not pass DMARC), so it was not taken as an answer.",
    off: "Answering by reply is turned off for your account, so your reply was not taken as an answer.",
    already: "This request was already answered, so your reply changed nothing.",
    expired: "This request had already expired, so your reply changed nothing.",
  }[args.reason];
  const open =
    args.reason === "already" || args.reason === "expired"
      ? "See where it stands"
      : "Approve or decline";
  return {
    to: args.email,
    subject: "Your reply was not taken as an answer",
    text: [why, "", `${open}: ${args.url}`].join("\n"),
    html: emailShell({
      preheader: why,
      heading: "Your reply was not taken as an answer",
      bodyHtml: paragraphs(escapeHtml(why)),
      action: { label: open, url: args.url },
      footnote: `Answering by reply can be turned off in ${PREFERENCES}.`,
    }),
    headers: { "Auto-Submitted": "auto-replied" },
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
