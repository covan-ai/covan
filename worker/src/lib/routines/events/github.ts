/**
 * GitHub: a push, a pull request or an issue starting a routine.
 *
 * NO GITHUB APP, ON PURPOSE. GitHub has two ways to tell somebody else that
 * something happened: an App, installed on an organisation, with its own
 * private key and permissions review; and a plain repository webhook, which
 * anybody who can open the repository's settings can add in a minute. A
 * routine that waits for pushes to one repository needs the second, and the
 * first would make every deployment register and run an App to offer it. So
 * each subscription is its own webhook: its own URL
 * (`/routine-events/github/<id>`), its own secret, pasted into the
 * repository's Settings → Webhooks by the person who wants it. The routine's
 * page shows both (`GET /routines/:id/event/setup`).
 *
 * WHY THE ID IN THE URL IS NOT THE ROUTINE'S. A routine id is not a secret —
 * it is in the app's URLs and in every shared link to the routine — and a
 * webhook URL is pasted into a third party's settings page, where whoever can
 * read the repository's settings can read it. So the URL carries a random id
 * of its own (`external_id`), and the signature with the secret is what makes
 * a delivery count: `authenticate` checks GitHub's `X-Hub-Signature-256`
 * before anything is read, and a delivery that fails it is refused at the
 * door (`receive.ts`), counted against the sender (`countMiss`), and runs
 * nothing.
 *
 * WHERE THE FILTERS GO. Here, in `matches`. GitHub's webhook settings choose
 * which kinds of event are sent — pushes, pull requests, issues — but not which
 * branch or which action, so a push to any branch arrives and the branch is
 * checked after it has. That is cheap: an event that does not match opens no
 * run and costs nothing but the request.
 */

import { z } from "zod";
import { base64url } from "../../jwt";
import { hmacSha256Hex, timingSafeEqual } from "../../hmac";
import type { EventAdapter, SubscribeResult } from "./adapter";
import type { EventTypeDef, NormalizedEvent } from "./catalog";
import { clip, lines, rec, str } from "./text";

/** What the receiving route hands over: GitHub's headers and the body, unread. */
export type GitHubDelivery = {
  /** `X-GitHub-Event`: push, pull_request, issues, ping, … */
  event: string;
  /** `X-GitHub-Delivery`: GitHub's id for this delivery. A redelivery keeps it. */
  delivery: string;
  /** `X-Hub-Signature-256`: `sha256=<hex>`. */
  signature: string;
  body: string;
};

/** The shape of the id in a GitHub webhook URL. The route refuses anything else. */
export const GITHUB_HOOK_ID = /^gh_[A-Za-z0-9_-]{32}$/;

/** Random enough that the URL is not guessable, short enough to paste. */
function newHookId(): string {
  return `gh_${base64url(crypto.getRandomValues(new Uint8Array(24)))}`;
}

function newSecret(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---- config ----------------------------------------------------------------

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

const PR_ACTIONS = [
  { value: "opened", label: "Opened" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed without merging" },
  { value: "reopened", label: "Reopened" },
  { value: "ready_for_review", label: "Marked ready for review" },
  { value: "any", label: "Anything happens to it" },
] as const;

const ISSUE_ACTIONS = [
  { value: "opened", label: "Opened" },
  { value: "closed", label: "Closed" },
  { value: "reopened", label: "Reopened" },
  { value: "any", label: "Anything happens to it" },
] as const;

const values = <T extends readonly { value: string }[]>(list: T) =>
  list.map((a) => a.value) as unknown as [string, ...string[]];

const pushConfig = z.object({ branch: optionalText(200) });
const pullRequestConfig = z.object({ action: z.enum(values(PR_ACTIONS)).default("opened") });
const issuesConfig = z.object({ action: z.enum(values(ISSUE_ACTIONS)).default("opened") });

/** Exact branch names, comma-separated. No wildcards, so `main` never matches `maintenance`. */
function branchesOf(config: Record<string, unknown>): string[] {
  return str(config.branch)
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
}

// ---- reading a delivery ------------------------------------------------------

/** The body as JSON, or null — a body that is not JSON is not GitHub's. */
function payloadOf(
  raw: unknown,
): { delivery: GitHubDelivery; payload: Record<string, unknown> } | null {
  const delivery = rec(raw) as GitHubDelivery | null;
  if (!delivery || typeof delivery.body !== "string") return null;
  try {
    const payload = rec(JSON.parse(delivery.body));
    return payload ? { delivery, payload } : null;
  } catch {
    return null;
  }
}

function repoOf(payload: Record<string, unknown>): string {
  return str(rec(payload.repository)?.full_name);
}

function login(value: unknown): string {
  return str(rec(value)?.login);
}

/** The id this event is remembered by: GitHub's delivery id, which a redelivery keeps. */
function eventIdOf(delivery: GitHubDelivery, fallback: string): string {
  return `github:${str(delivery.delivery) || fallback}`;
}

function describePush(
  delivery: GitHubDelivery,
  p: Record<string, unknown>,
): NormalizedEvent | null {
  const ref = str(p.ref);
  // A tag, or a branch being deleted: nothing was pushed to a branch.
  if (!ref.startsWith("refs/heads/") || p.deleted === true) return null;
  const branch = ref.slice("refs/heads/".length);
  const repository = repoOf(p);
  const commits = Array.isArray(p.commits) ? p.commits.map(rec).filter((c) => c !== null) : [];
  const listed = commits.slice(0, 20).map((c) => {
    const sha = str(c.id).slice(0, 7);
    const message = str(c.message).split("\n")[0];
    const author = str(rec(c.author)?.name);
    return `- ${sha} ${message}${author ? ` — ${author}` : ""}`;
  });
  if (commits.length > listed.length) listed.push(`- …and ${commits.length - listed.length} more`);
  const header = lines([
    ["Repository", repository],
    ["Branch", branch],
    ["Pushed by", str(rec(p.pusher)?.name) || login(p.sender)],
    ["Commits", String(commits.length)],
    ["Compare", str(p.compare)],
  ]);
  return {
    eventId: eventIdOf(delivery, `push:${str(p.after)}`),
    text: listed.length ? `${header}\n\n${listed.join("\n")}` : header,
    label: `GitHub · Push to ${branch}`.slice(0, 120),
    fields: { branch, repository },
  };
}

function describePullRequest(
  delivery: GitHubDelivery,
  p: Record<string, unknown>,
): NormalizedEvent | null {
  const pr = rec(p.pull_request);
  if (!pr) return null;
  const raw = str(p.action);
  const action = raw === "closed" && pr.merged === true ? "merged" : raw;
  const number = str(pr.number) || str(p.number);
  const header = lines([
    ["Repository", repoOf(p)],
    ["Pull request", `#${number} ${str(pr.title)}`],
    ["What happened", action.replace(/_/g, " ")],
    ["Author", login(pr.user)],
    ["By", login(p.sender)],
    ["Branches", [str(rec(pr.head)?.ref), str(rec(pr.base)?.ref)].filter(Boolean).join(" → ")],
    ["Link", str(pr.html_url)],
  ]);
  const body = str(pr.body);
  return {
    eventId: eventIdOf(delivery, `pr:${number}:${raw}:${str(pr.updated_at)}`),
    text: body ? `${header}\n\n${clip(body)}` : header,
    label: `GitHub · Pull request ${action.replace(/_/g, " ")}`.slice(0, 120),
    fields: { action, repository: repoOf(p) },
  };
}

function describeIssue(
  delivery: GitHubDelivery,
  p: Record<string, unknown>,
): NormalizedEvent | null {
  const issue = rec(p.issue);
  // GitHub sends pull requests through `issues` too, for some actions.
  if (!issue || issue.pull_request) return null;
  const action = str(p.action);
  const number = str(issue.number);
  const labels = Array.isArray(issue.labels)
    ? issue.labels
        .map((l) => str(rec(l)?.name))
        .filter(Boolean)
        .join(", ")
    : "";
  const header = lines([
    ["Repository", repoOf(p)],
    ["Issue", `#${number} ${str(issue.title)}`],
    ["What happened", action],
    ["Opened by", login(issue.user)],
    ["By", login(p.sender)],
    ["Labels", labels],
    ["Link", str(issue.html_url)],
  ]);
  const body = str(issue.body);
  return {
    eventId: eventIdOf(delivery, `issue:${number}:${action}:${str(issue.updated_at)}`),
    text: body ? `${header}\n\n${clip(body)}` : header,
    label: `GitHub · Issue ${action}`.slice(0, 120),
    fields: { action, repository: repoOf(p) },
  };
}

// ---- the entries ----------------------------------------------------------------

const REQUIRES = { kind: "none" } as const;

export type GitHubEventSpec = {
  def: EventTypeDef;
  /** The `X-GitHub-Event` this entry is for. Any other is not for it. */
  githubEvent: string;
  describe: (delivery: GitHubDelivery, payload: Record<string, unknown>) => NormalizedEvent | null;
};

export const GITHUB_EVENTS: readonly GitHubEventSpec[] = [
  {
    githubEvent: "push",
    describe: describePush,
    def: {
      id: "github.push",
      provider: "github",
      app: "GitHub",
      label: "Push",
      description:
        "Runs when commits are pushed to a repository you add this routine's webhook to.",
      requires: REQUIRES,
      config: pushConfig,
      fields: [
        {
          key: "branch",
          label: "Only pushes to",
          kind: "text",
          optional: true,
          placeholder: "main",
          help: "A branch name, or several separated by commas. Empty means every branch.",
        },
      ],
      matches: (config, event) => {
        const wanted = branchesOf(config);
        return wanted.length === 0 || wanted.includes(event.fields?.branch ?? "");
      },
      sample: {
        eventId: "sample",
        fields: { branch: "main", repository: "acme/website" },
        text:
          lines([
            ["Repository", "acme/website"],
            ["Branch", "main"],
            ["Pushed by", "ayse"],
            ["Commits", "2"],
          ]) +
          "\n\n- 3f2a91c Fix the pricing table on mobile — Ayşe Demir\n- 8c01d4e Bump the footer year — Ayşe Demir",
      },
    },
  },
  {
    githubEvent: "pull_request",
    describe: describePullRequest,
    def: {
      id: "github.pull_request",
      provider: "github",
      app: "GitHub",
      label: "Pull request",
      description:
        "Runs when a pull request is opened, merged or closed in a repository you add this routine's webhook to.",
      requires: REQUIRES,
      config: pullRequestConfig,
      fields: [
        {
          key: "action",
          label: "When it is",
          kind: "select",
          optional: true,
          placeholder: "Opened",
          options: [...PR_ACTIONS],
          help: "“Anything happens to it” includes every new commit pushed to it.",
        },
      ],
      matches: (config, event) => {
        const wanted = str(config.action) || "opened";
        return wanted === "any" || event.fields?.action === wanted;
      },
      sample: {
        eventId: "sample",
        fields: { action: "opened", repository: "acme/website" },
        text:
          lines([
            ["Repository", "acme/website"],
            ["Pull request", "#142 Add a dark mode toggle"],
            ["What happened", "opened"],
            ["Author", "mert"],
            ["Branches", "dark-mode → main"],
          ]) + "\n\nAdds a toggle to the header and remembers the choice. Screenshots below.",
      },
    },
  },
  {
    githubEvent: "issues",
    describe: describeIssue,
    def: {
      id: "github.issues",
      provider: "github",
      app: "GitHub",
      label: "Issue",
      description:
        "Runs when an issue is opened or closed in a repository you add this routine's webhook to.",
      requires: REQUIRES,
      config: issuesConfig,
      fields: [
        {
          key: "action",
          label: "When it is",
          kind: "select",
          optional: true,
          placeholder: "Opened",
          options: [...ISSUE_ACTIONS],
        },
      ],
      matches: (config, event) => {
        const wanted = str(config.action) || "opened";
        return wanted === "any" || event.fields?.action === wanted;
      },
      sample: {
        eventId: "sample",
        fields: { action: "opened", repository: "acme/website" },
        text:
          lines([
            ["Repository", "acme/website"],
            ["Issue", "#87 Checkout button does nothing on Safari"],
            ["What happened", "opened"],
            ["Opened by", "customer-success"],
            ["Labels", "bug"],
          ]) + "\n\nSteps: add anything to the cart, press Checkout on Safari 17. Nothing happens.",
      },
    },
  },
];

function githubSpec(type: string): GitHubEventSpec | undefined {
  return GITHUB_EVENTS.find((s) => s.def.id === type);
}

// ---- the adapter -------------------------------------------------------------------

export const GITHUB_ADAPTER: EventAdapter = {
  provider: "github",
  // Nothing to configure: the URL is this API's own, the secret is made here.
  isConfigured: () => true,

  // Idempotent the only way it can be: a row that already has its URL and
  // secret keeps them, because they are pasted into GitHub and a sync that
  // changed them would silently break the webhook the person set up.
  async subscribe(ctx): Promise<SubscribeResult> {
    if (ctx.subscription.external_id && ctx.secret) {
      return { externalId: ctx.subscription.external_id, secret: ctx.secret };
    }
    return { externalId: newHookId(), secret: newSecret() };
  },

  // Nothing at GitHub is ours to end — the webhook is in the person's
  // repository settings. Once the row is gone its URL answers 404, and GitHub
  // shows that against the webhook, which is the person's cue to remove it.
  async unsubscribe() {},

  // Nor to pause: a delivery to a paused routine is refused in `receive.ts`.
  async setEnabled() {},

  async authenticate(raw, ctx) {
    const delivery = rec(raw) as GitHubDelivery | null;
    if (!ctx.secret || !delivery || typeof delivery.body !== "string") return false;
    const signature = str(delivery.signature);
    if (!signature.startsWith("sha256=")) return false;
    const expected = `sha256=${await hmacSha256Hex(ctx.secret, delivery.body)}`;
    return timingSafeEqual(expected, signature);
  },

  async normalize(raw, ctx) {
    const spec = githubSpec(ctx.subscription.event_type);
    const read = payloadOf(raw);
    // `ping` is GitHub checking the URL works when the webhook is added; a
    // pull request arriving at a routine that waits for pushes was sent
    // because the webhook was set to send everything. Neither runs anything.
    if (!spec || !read || read.delivery.event !== spec.githubEvent) return null;
    return spec.describe(read.delivery, read.payload);
  },
};
