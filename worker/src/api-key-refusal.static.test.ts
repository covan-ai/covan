import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A ratchet on the one sentence an API key is not allowed to break.
 *
 * A key is not a scope list — it is a way to become the person who owns it, and
 * RLS decides the rest. `lib/api-key-rule.ts` holds the single exception: a key
 * may not create access that survives its own revocation, because revoking a
 * leaked key has to be the end of the incident rather than the middle of one.
 *
 * Nothing about that rule is enforceable by the database, and that is what
 * makes forgetting it quiet. A key authenticates as its owner, so a route that
 * creates access and never asks behaves identically for a key and for a
 * session: same 200, same row, every policy satisfied, every other test in this
 * repo still green. The only evidence arrives later, when a revoked key's
 * invitee is still an admin and nobody can say which call let them in.
 *
 * `POST /invitations` and `PATCH /workspace/members/:userId` were exactly that
 * for the whole life of the feature — finding 7 of the 2026-10-08 audit — while
 * the reasoning that forbids them sat written out in `routes/api-keys.ts` two
 * files away. Two routes asked, two routes that did the same thing did not, and
 * the difference was invisible.
 *
 * The same gap turned up again, wider: OAuth, Slack, Composio
 * and tool connections, membership changes, and switching workspaces, none of
 * them refused. So the rule is now inverted where it can be seen whole — every
 * handler behind `authMiddleware` has to appear in one of two lists below, and
 * a route nobody has sorted fails this file. Forgetting is no longer quiet.
 *
 * What it looks for is a *call*, and comments are stripped before it looks. The
 * first draft of this file asked only whether the name appeared in the file,
 * and `import { refuseIfKeyAuthenticated } from …` is the name appearing in the
 * file: deleting the two-line refusal from `routes/workspace.ts` and leaving
 * the import satisfied it, with finding 7 reopened. Nothing else would have
 * caught the orphan either — `no-unused-vars` is off for this package and
 * `noUnusedLocals` is not set.
 */
const SRC = join(process.cwd(), "src");

/** The helper that states the rule, and the names that count as asking. */
const RULE = "lib/api-key-rule.ts";
const ASKS = ["refuseIfKeyAuthenticated(", 'c.get("apiKeyId")'];

/**
 * Every authenticated handler, sorted into the two answers it can give a key.
 *
 * This used to be a list of FILES that had to refuse a key
 * somewhere, and it was blind twice over. Inside a file: `routes/browser.ts`'s
 * `GET .../current` handed back a live URL with no refusal of its own while
 * `POST`'s answered for it. And across files: nothing listed
 * `routes/connections.ts`, `composio.ts`, `slack.ts` or `tool-connections.ts`,
 * so a key could start an OAuth flow, plant a Composio grant, or repoint a
 * Drive folder -- third-party access that keeps working after the key is
 * revoked -- and every test stayed green.
 *
 * So the question is now asked of every handler, and a handler that is in
 * neither list fails this file. A new route cannot be added without somebody
 * deciding, in writing, whether a key may reach it. That is the allowlist the
 * rule's docblock asked for, held at the one place that can see every route.
 *
 * Keyed `"<file> <METHOD> <path>"`.
 */
const HANDLERS_BEYOND_THE_KEY: Record<string, string> = {
  "routes/trash.ts DELETE /trash/:kind/:id":
    "deleting for good: the thirty-day undo is gone the moment it runs, so a leaked key could destroy a workspace's knowledge past any revocation",
  "routes/memory.ts POST /memory":
    "writes a sentence that is read into an agent's instructions in every later conversation, and a team note into every member's — so a leaked key could plant instructions that keep steering the agents after the key is revoked",
  "routes/memory.ts PATCH /memory/:id":
    "rewrites or shares a sentence that is read into agents' instructions, which a revoked key would leave in place",
  "routes/memory.ts DELETE /memory/:id":
    "removes a note for good, with no thirty-day undo, so a leaked key could wipe what a team taught its agents past any revocation",
  // -- keys and the account
  "routes/api-keys.ts POST /api-keys":
    "mints a key, and a key that writes successors cannot be revoked: the moment one leaks it makes more",
  "routes/api-keys.ts DELETE /api-keys/:id":
    "revokes a key, so a leaked key could take down the keys somebody is still relying on",
  "routes/account.ts DELETE /account":
    "closes the account, which destroys the evidence and the account in one call and cannot be undone by revoking anything",

  "routes/onboarding.ts POST /onboarding/finish":
    "stamps an account as arrived, makes its first agent and conversation and sends its welcome — a first run is the person's own to finish, and none of it is undone by revoking the key",

  // -- people
  "routes/invitations.ts POST /invitations":
    "invites people, and what comes back is a second person with their own session — access in a third party's hands that revoking the key does not touch",
  "routes/invitations.ts POST /invitations/:id/resend":
    "mints a new invitation link, a way into the workspace for whoever holds it that revoking the key does not reach",
  "routes/invitations.ts DELETE /invitations/:id":
    "revokes somebody's invitation, deciding who may join the workspace on the owner's behalf",
  "routes/invitations.ts POST /invitations/:id/accept":
    "joins the owner to another workspace, a membership that outlives the key and that the key's own workspace lock cannot see",
  "routes/workspace.ts PATCH /workspace/members/:userId":
    "changes what a member may do, so a viewer promoted to admin by a key stays an admin after the key is gone",
  "routes/workspace.ts DELETE /workspace/members/:userId":
    "removes somebody from the workspace, taking their access, their keys and their seat with it — not undone by revoking anything",
  "routes/workspace.ts DELETE /workspace/members/me":
    "takes the owner out of the workspace, which a revoked key cannot give back",
  "routes/workspace.ts POST /workspace/deletion":
    "schedules the end of a workspace a fortnight out, which outlives any revocation of the key that asked for it",
  "routes/account.ts DELETE /account/sessions/:id":
    "signs one of the owner's own browsers out; a key that could do it could lock the owner out of every session but the leaked one",
  "routes/invite-links.ts POST /invite-links":
    "mints a link anybody holding it can join with for a week, which outlives any revocation of the key that made it",
  "routes/invite-links.ts POST /invite-links/accept":
    "joins the owner to another workspace, access that outlives the key",
  "routes/workspace.ts POST /workspaces":
    "creates a workspace, somewhere new for the owner's data to go that the key's own workspace lock does not reach",
  "routes/workspace.ts POST /workspace/active":
    "moves the owner's own sessions into another workspace, reaching past the one the key belongs to",

  // -- third parties: set up, changed and removed with a session only
  "routes/connections.ts POST /connections/:provider/start":
    "starts an OAuth flow, and the grant it ends in reads a Drive or a Notion into the workspace long after the key is revoked",
  "routes/connections.ts POST /connections/complete":
    "exchanges an OAuth code and stores the token it buys, the second half of starting a connection",
  "routes/slack.ts POST /slack/complete":
    "exchanges Slack's code and stores the bot token it buys, the second half of installing Slack",
  "routes/composio.ts POST /composio/complete":
    "activates a connected application, the second half of connecting one",
  "routes/connections.ts POST /connections/:id/reconnect":
    "re-grants a source with fresh OAuth tokens, access that outlives the key exactly as starting one does",
  "routes/connections.ts GET /connections/:id/folders":
    "browses the grant holder's Drive with their own token — reconnaissance of a third party's files that no key-driven caller needs",
  "routes/connections.ts PATCH /connections/:id":
    "choosing a folder decides what the owner's grant imports from now on, which outlives the key; pausing and the cadence stay open",
  "routes/connections.ts DELETE /connections/:id":
    "tears down a source the whole workspace syncs from — integrations are set up and removed with a session, never by a script",
  "routes/composio.ts POST /composio/connect":
    "connects an application to the owner's account at a third party, a grant that keeps working after the key is revoked",
  // 0139: a scan of what arrived is one person's own count of their mailbox,
  // and its policies refuse a key's token whatever the route does.
  "routes/arrivals.ts POST /arrivals":
    "reads a person's mailbox and calendar through their own connections and spends the workspace's credits doing it, after the response — a scan started by a leaked key finishes after it is revoked",
  "routes/arrivals.ts GET /arrivals/latest":
    "how many questions one person never answered and what their mail is about: something a person looks at in the product, which the table's policy refuses a key's token anyway",
  "routes/arrivals.ts GET /arrivals/:id":
    "the same scan by its id, and the same answer",
  "routes/arrivals.ts PATCH /arrivals/:id/buckets/:kind":
    "records which routine a person made from a proposal, a write the table's policy refuses a key's token anyway",
  "routes/composio.ts GET /composio/connections/:id/status":
    "finishes a connection the poll finds active, which is the second half of connecting an application",
  "routes/composio.ts PUT /composio/grants":
    "lets an agent act in a connected application — an always-allow planted by a key keeps firing after it is revoked",
  "routes/composio.ts DELETE /composio/grants":
    "changes what an agent may do in a connected application, the same decision as granting it",
  "routes/slack.ts POST /slack/install/start":
    "installs Covan into a Slack workspace, a bot token that keeps answering long after the key is revoked",
  "routes/slack.ts PATCH /slack/installation":
    "changes which agent answers in Slack, deciding who a third party's workspace talks to",
  "routes/slack.ts DELETE /slack/installation":
    "removes the Slack installation a whole team may be relying on",
  "routes/tool-connections.ts POST /tool-connections":
    "stores a credential for a service the agent can then call on every later run, after the key is revoked",
  "routes/tool-connections.ts PATCH /tool-connections/:id":
    "re-scopes a stored service credential, changing what agents may do with it from now on",
  "routes/tool-connections.ts DELETE /tool-connections/:id":
    "removes a service credential somebody's agents depend on",
  "routes/billing.ts PATCH /billing/settings":
    "turns on buying credits with the workspace's saved card, which keeps charging after the key is revoked",
  "routes/model-endpoints.ts POST /model-endpoints":
    "stores a credential and an address every later reply on that model is sent to, after the key is revoked",
  "routes/model-endpoints.ts DELETE /model-endpoints/:id":
    "takes away a model somebody's agents answer on",
  "routes/webhooks.ts POST /webhooks":
    "hands back a signing secret and points the workspace's events at a URL of the key-holder's choosing, which keeps receiving after the key is revoked",
  "routes/webhooks.ts PATCH /webhooks/:id":
    "re-points where the workspace's events are sent, or turns a webhook back on, and that outlives the key",
  "routes/webhooks.ts POST /webhooks/:id/rotate":
    "hands back a fresh signing secret, so whoever holds it can sign payloads as this workspace after the key is revoked",
  "routes/routines.ts POST /delivery-channels/:id/rotate":
    "hands back a fresh webhook signing secret, so whoever holds it can sign payloads to the owner's endpoint after the key is revoked",
  "routes/routines.ts PUT /routines/:id/event":
    "attaches a listener at a third party to a routine that may have been made in a session, which a revoked key does not pause — a routine the key itself creates is paused on revocation (0088), and its listener with it",
  "routes/routines.ts GET /routines/:id/event/setup":
    "hands back a GitHub webhook's secret, so whoever holds it can start the routine with a signed delivery after the key is revoked",

  // -- the owner's browser
  "routes/browser.ts POST /browser/takeovers":
    "opens a browser carrying the owner's own signed-in cookies, a live session that outlives the key",
  "routes/browser.ts GET /browser/takeovers/current":
    "hands back the live URL of a browser carrying the owner's signed-in cookies",
  "routes/browser.ts POST /browser/takeovers/:id/close":
    "ends a sign-in the owner may be in the middle of and decides what their cookie jar keeps",
  "routes/browser.ts GET /browser/profile":
    "reads which sites the owner is signed in to — reconnaissance no key-driven caller needs",
  "routes/browser.ts DELETE /browser/profile":
    "throws away every site the owner is signed in to, which revoking the key does not undo",
  "routes/browser.ts GET /browser/sessions/:id/live":
    "hands back the live view URL of a browser carrying the owner's signed-in cookies — a credential the provider says gives full control of that browser, and revoking the key does not end it",
  "routes/browser.ts POST /browser/sessions/:id/take-over":
    "puts the owner's browser in human hands, which is the state in which the panel's live URL becomes the controls of a browser carrying their signed-in sessions",
  "routes/browser.ts POST /browser/sessions/:id/hand-back":
    "starts a run in the owner's signed-in browser and spends the one free retry on their behalf, an act the owner never took that outlives the key",
  "routes/browser.ts POST /browser/sessions/:id/stop":
    "stops somebody's browser, ending a sign-in they may be in the middle of and deciding what their cookie jar keeps",
  "routes/browser.ts POST /browser/tasks/:id/cancel":
    "takes a task somebody approved out of their browser's line, deciding what their browser does next on their behalf",
  "routes/browser.ts GET /browser/sessions":
    "lists which of somebody's browsers are open right now, in which conversations and in whose hands — a map of where a signed-in browser of theirs can be found, read the way GET /browser/profile and GET /browser/credentials are refused: reconnaissance rather than work, which no key-driven caller needs",
  "routes/browser.ts GET /browser/credentials":
    "lists which sites somebody has a saved login for, and on which agents — reconnaissance about where their passwords are kept, which no key-driven caller needs",
  "routes/browser.ts POST /browser/credentials":
    "saves a site's password for an agent, so every later run signs in as that person — a login planted by a key keeps working after the key is revoked",
  "routes/browser.ts DELETE /browser/credentials/:id":
    "forgets a saved login, possibly a shared one the whole team's agent signs in with — a destructive act on their behalf that revoking the key does not undo",
};

/**
 * Handlers a key may reach, because everything they do is undone or stopped by
 * revoking it, or is a read the owner's own policies already answer.
 *
 * Routines, delivery channels and ingest triggers are here on purpose, and it
 * is the one place that is not obvious: they run on their own long after the
 * request that made them, which is what the rule forbids. They are allowed
 * because a key that makes one is written onto it (`api_key_id`, 0088) and
 * revoking the key pauses the routine, disables the channel and deletes the
 * trigger. A scheduled job driven by a key is the API's main use; the tag is
 * what lets it survive the rule.
 */
const OPEN_TO_A_KEY = new Set([
  "routes/billing.ts GET /billing/settings",
  "routes/billing.ts GET /billing/invoices",
  "routes/billing.ts GET /billing/invoices/:id/pdf",
  "routes/agents.ts GET /agents",
  "routes/agents.ts POST /agents",
  "routes/agents.ts PATCH /agents/:id",
  "routes/agents.ts DELETE /agents/:id",
  "routes/agents.ts GET /agents/:id/delete-summary",
  "routes/agents.ts GET /agents/:id/knowledge-usage",
  "routes/home.ts GET /home/overview",
  "routes/invite-links.ts GET /invite-links",
  "routes/invite-links.ts DELETE /invite-links/:id",
  "routes/account.ts GET /account/sessions",
  "routes/account.ts GET /account/identities",
  "routes/workspace-icons.ts PUT /workspace/icon",
  "routes/workspace-icons.ts DELETE /workspace/icon",
  "routes/workspace.ts GET /workspace/members",
  "routes/workspace.ts DELETE /workspace/deletion",
  "routes/inbox.ts GET /inbox",
  "routes/inbox.ts GET /inbox/counts",
  "routes/inbox.ts POST /inbox/read",
  "routes/inbox.ts POST /inbox/read-all",
  // Changing who can use an agent is a write the owner's own policies answer
  // (only full access gets past `set_agent_sharing`), and nothing it does runs
  // on after the key is gone: a share is a row, not a job.
  "routes/agents.ts PUT /agents/:id/sharing",
  "routes/api-keys.ts GET /api-keys",
  "routes/avatars.ts PUT /me/avatar",
  "routes/avatars.ts DELETE /me/avatar",
  "routes/brainstorm.ts POST /brainstorm/ideas/suggest",
  "routes/bundles.ts GET /bundles",
  "routes/bundles.ts GET /knowledge/usage",
  "routes/bundles.ts POST /bundles/:id/documents/url",
  "routes/documents.ts POST /documents/:id/resync",
  "routes/bundles.ts GET /bundles/citations",
  "routes/bundles.ts GET /bundles/:id/documents",
  "routes/bundles.ts POST /bundles",
  "routes/bundles.ts PATCH /bundles/:id",
  "routes/bundles.ts DELETE /bundles/:id",
  "routes/bundles.ts POST /agents/:id/bundles/:bundleId",
  "routes/bundles.ts DELETE /agents/:id/bundles/:bundleId",
  "routes/bundles.ts POST /bundles/:id/documents/upload",
  // The same upload in parts. Revoking the key stops every later part, and an
  // unfinished upload is nothing but bytes the store discards.
  "routes/uploads.ts POST /bundles/:id/uploads",
  "routes/uploads.ts PUT /uploads/parts",
  "routes/uploads.ts POST /uploads/complete",
  "routes/uploads.ts POST /uploads/abort",
  "routes/bundles.ts POST /admin/backfill-embeddings",
  "routes/chat.ts POST /chat/stream",
  "routes/chat.ts POST /chat/confirm/:id",
  "routes/composio.ts GET /composio/toolkits",
  "routes/composio.ts GET /composio/toolkits/:slug",
  "routes/composio.ts GET /composio/categories",
  "routes/composio.ts GET /composio/grants",
  "routes/connections.ts GET /connections",
  "routes/connections.ts GET /connections/:id/runs",
  "routes/connections.ts POST /connections/:id/sync",
  "routes/coverage.ts GET /coverage/workspace",
  "routes/coverage.ts GET /coverage/documents",
  "routes/coverage.ts PATCH /coverage/settings",
  "routes/coverage.ts PUT /coverage/preference",
  "routes/coverage.ts GET /coverage/preference",
  "routes/documents.ts DELETE /documents/:id",
  "routes/documents.ts PATCH /documents/:id",
  "routes/documents.ts GET /documents/:id/preview",
  "routes/documents.ts GET /documents/:id/download",
  "routes/documents.ts GET /documents/:id/export/:format",
  "routes/documents.ts POST /documents/:id/reindex",
  "routes/events.ts GET /events",
  "routes/export.ts GET /workspaces/:id/export",
  "routes/export.ts GET /workspaces/:id/exports",
  "routes/export.ts POST /workspaces/:id/exports",
  "routes/export.ts GET /exports/:id/download",
  "routes/favorites.ts POST /agents/:id/favorite",
  "routes/favorites.ts GET /favorites",
  "routes/feedback.ts POST /feedback",
  "routes/ideas.ts GET /sessions/:id/ideas",
  "routes/ideas.ts POST /sessions/:id/ideas",
  "routes/ideas.ts PATCH /ideas/:id",
  "routes/ideas.ts DELETE /ideas/:id",
  "routes/invitations.ts GET /invitations",
  "routes/invitations.ts GET /invitations/incoming",
  "routes/me.ts GET /me",
  "routes/me.ts PATCH /me",
  "routes/memory.ts GET /memory",
  "routes/messages.ts POST /messages",
  "routes/messages.ts PATCH /messages/:id",
  "routes/messages.ts DELETE /messages/after/:id",
  "routes/messages.ts POST /messages/:id/show",
  "routes/notifications.ts GET /notification-preferences",
  "routes/notifications.ts PATCH /notification-preferences",
  "routes/onboarding.ts GET /onboarding",
  "routes/onboarding.ts PATCH /onboarding",
  "routes/onboarding.ts POST /onboarding/complete",
  "routes/onboarding.ts POST /onboarding/events",
  "routes/persona.ts POST /persona/suggest",
  "routes/reports.ts POST /sessions/:id/report",
  "routes/document-jobs.ts GET /sessions/:id/document-jobs",
  "routes/document-jobs.ts GET /document-jobs/:id",
  "routes/document-jobs.ts POST /document-jobs/:id/stop",
  "routes/document-jobs.ts POST /document-jobs/:id/retry",
  "routes/routines.ts POST /routines/draft",
  "routes/routines.ts GET /delivery-channels",
  "routes/routines.ts POST /delivery-channels",
  "routes/routines.ts POST /delivery-channels/:id/test",
  "routes/routines.ts DELETE /delivery-channels/:id",
  "routes/routines.ts GET /routines",
  "routes/routines.ts POST /routines",
  "routes/routines.ts PATCH /routines/:id",
  "routes/routines.ts POST /routines/:id/run",
  "routes/routines.ts DELETE /routines/:id",
  "routes/routines.ts GET /routines/:id/runs",
  "routes/routines.ts GET /routines/stats",
  "routes/webhooks.ts GET /webhooks",
  "routes/model-endpoints.ts GET /model-endpoints",
  "routes/webhooks.ts DELETE /webhooks/:id",
  "routes/webhooks.ts POST /webhooks/:id/test",
  "routes/webhooks.ts POST /webhooks/deliveries/:id/resend",
  "routes/routines.ts GET /routines/estimate",
  "routes/routines.ts PUT /routines/:id/channels",
  "routes/routines.ts POST /routines/:id/test",
  "routes/routines.ts GET /routines/:id/trigger",
  "routes/routines.ts POST /routines/:id/trigger",
  "routes/routines.ts DELETE /routines/:id/trigger",
  // 0109. Reading what can be listened for, stopping a listener and running a
  // test are open: none of them leaves anything running after the key is gone.
  "routes/routines.ts GET /routines/events/catalog",
  "routes/routines.ts DELETE /routines/:id/event",
  "routes/routines.ts POST /routines/:id/event/test",
  "routes/search.ts GET /search/messages",
  "routes/sessions.ts GET /sessions",
  "routes/sessions.ts GET /sessions/table",
  "routes/sessions.ts POST /sessions",
  "routes/sessions.ts PATCH /sessions/:id",
  "routes/sessions.ts DELETE /sessions/:id",
  "routes/sessions.ts GET /sessions/:id/messages",
  "routes/sessions.ts GET /sessions/:id/browser-tasks",
  // 0117. Marks a step claimed and starts nothing: the turn after it is an
  // ordinary chat request, which a key may already make.
  "routes/sessions.ts POST /sessions/:id/browser-tasks/continue",
  "routes/slack.ts GET /slack",
  "routes/support.ts POST /support/quota",
  "routes/tool-connections.ts GET /tool-connections",
  "routes/transcribe.ts POST /transcribe",
  "routes/trash.ts GET /trash",
  "routes/trash.ts POST /trash/:kind/:id/restore",
  // Reading and stopping a turn the same caller could start. Nothing here
  // outlives the request — a stop ends work, it never starts any.
  "routes/turns.ts GET /sessions/:id/turn",
  "routes/turns.ts GET /sessions/:id/turn/stream",
  "routes/turns.ts POST /sessions/:id/turn/stop",
  "routes/usage.ts GET /usage",
  "routes/usage.ts GET /usage/credits/ledger",
  "routes/usage.ts GET /usage/credits/month",
  "routes/usage.ts GET /usage/workspace",
  "routes/workspace.ts PATCH /workspace",
  "routes/workspace.ts GET /workspaces",
  "routes/workspace.ts GET /workspace/members/:userId/key-count",
]);

/**
 * Routers mounted outside `authMiddleware`, where there is no key to refuse:
 * the caller is a provider's redirect, Slack, an `<img>` or a webhook sender.
 */
const OUTSIDE_THE_SESSION: Record<string, string> = {
  connectionsPublic: "the OAuth provider's redirect back, which carries no bearer token",
  slackPublic: "Slack's own redirect and event deliveries, verified by signature",
  avatarsPublic: "an <img> fetching a profile photo, whose unguessable URL is the capability",
  inviteLinkPreview:
    "the invite page before sign-in, holding the link's token, which is the credential",
  workspaceIconsPublic:
    "an <img> fetching a workspace's icon, whose unguessable URL is the capability",
  composioPublic: "a logo proxy for <img> tags, serving nothing about anybody",
  routineHooks: "a third-party sender holding an ingest token, which is the credential",
  composioEvents: "Composio's trigger deliveries, verified by the webhook signature",
  notionEvents:
    "Notion's webhook deliveries, verified by the integration's signature once its token is set",
  routineEvents:
    "GitHub webhooks and WebSub hubs, each delivery verified by its own subscription's secret",
  emailInbound:
    "Resend's inbound mail deliveries, verified by the webhook signature and the sender's SPF, DKIM and DMARC",
  addressConfirmationsPublic:
    "somebody at an email address confirming it, holding the token mailed to it",
  invitationPreview:
    "the /invite page before sign-in, holding the invitation's id and the token mailed with it",
};

/** Every `<router>.<method>("<path>"` registration in a route file. */
function handlersIn(file: string): Array<{ router: string; key: string; body: string }> {
  const code = codeOnly(readFileSync(join(SRC, file), "utf8"));
  const out: Array<{ router: string; key: string; body: string }> = [];
  const pattern = /\n(\w+)\.(get|post|put|patch|delete)\("([^"]+)"/g;
  for (const match of code.matchAll(pattern)) {
    const start = (match.index ?? 0) + 1;
    // To the next handler registered on any router, or the end of the file.
    const rest = code.slice(start + 1);
    const next = rest.search(/\n\w+\.(get|post|put|patch|delete)\(/);
    out.push({
      router: match[1],
      key: `${file} ${match[2].toUpperCase()} ${match[3]}`,
      body: next === -1 ? rest : rest.slice(0, next),
    });
  }
  return out;
}

/**
 * Files permitted to read `apiKeyId` off the context directly.
 *
 * Everything else asks through the helper, so the rule is stated once and the
 * reasoning lives next to it. A third hand-rolled copy is how the two routes in
 * finding 7 came to disagree with the two that asked.
 */
const TOUCHES_THE_BINDING = new Map([
  ["types.ts", "declares the context variable"],
  ["middleware/auth.ts", "sets it — the one place a key becomes a caller"],
  [RULE, "states the rule"],
]);

/** Every source file under src/, excluding tests and their scaffolding. */
function sourceFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      if (entry === "test-support") continue;
      out.push(...sourceFiles(full, rel));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(rel);
    }
  }
  return out;
}

const files = sourceFiles(SRC);

/**
 * The same text with its comments removed.
 *
 * Crude — a `//` inside a string literal goes with them unless a `:` precedes
 * it. It does not need to be better: what it is for is making sure a claim
 * written in a comment cannot stand in for the code that would honour it.
 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function mentions(file: string, needle: string): boolean {
  return codeOnly(readFileSync(join(SRC, file), "utf8")).includes(needle);
}

describe("the one thing an API key may not do", () => {
  it("has a source tree and a rule to look at", () => {
    // Without this, a bad path would make every assertion below pass on nothing.
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain(RULE);
    expect(mentions(RULE, "export function refuseIfKeyAuthenticated(")).toBe(true);
    // And the needles are call shapes, not bare names, so an orphan import
    // cannot answer for a refusal that was deleted.
    expect(ASKS.every((needle) => needle.includes("("))).toBe(true);
  });

  const routeFiles = files.filter((f) => f.startsWith("routes/"));
  const handlers = routeFiles.flatMap(handlersIn);
  const authenticated = handlers.filter((h) => !(h.router in OUTSIDE_THE_SESSION));

  it("finds the routes it is meant to be sorting", () => {
    expect(authenticated.length).toBeGreaterThan(100);
  });

  it("has an answer for every handler a key can reach", () => {
    const unsorted = authenticated
      .map((h) => h.key)
      .filter((key) => !(key in HANDLERS_BEYOND_THE_KEY) && !OPEN_TO_A_KEY.has(key));

    expect(
      unsorted,
      "these handlers are behind authMiddleware, so an API key reaches them, and nobody " +
        "has decided whether it should. Add each to HANDLERS_BEYOND_THE_KEY (and refuse " +
        `the key with ${ASKS[0]}c, …) inside the handler) if what it does would outlive ` +
        "a revoked key, or to OPEN_TO_A_KEY if revoking the key stops it.",
    ).toEqual([]);
  });

  it("gives every handler one answer, and only handlers that exist", () => {
    const registered = new Set(authenticated.map((h) => h.key));
    const both = [...OPEN_TO_A_KEY].filter((key) => key in HANDLERS_BEYOND_THE_KEY);
    const stale = [...OPEN_TO_A_KEY, ...Object.keys(HANDLERS_BEYOND_THE_KEY)].filter(
      (key) => !registered.has(key),
    );
    expect(both, "listed as both open and refused").toEqual([]);
    expect(stale, "listed, but no longer registered — remove the line").toEqual([]);
  });

  it("does not refuse a key in a handler that says it is open to one", () => {
    // Otherwise OPEN_TO_A_KEY stops being a description of the API and the
    // documentation built from it says something untrue.
    const refusing = authenticated
      .filter((h) => OPEN_TO_A_KEY.has(h.key))
      .filter((h) => ASKS.some((name) => h.body.includes(name)))
      .map((h) => h.key);
    expect(refusing).toEqual([]);
  });

  it("mounts the routers it treats as public outside the authenticated one", () => {
    const index = codeOnly(readFileSync(join(SRC, "index.ts"), "utf8"));
    for (const router of Object.keys(OUTSIDE_THE_SESSION)) {
      expect(index, `${router} is not mounted on app`).toContain(`app.route("/", ${router})`);
      expect(index, `${router} is mounted behind authMiddleware`).not.toContain(
        `api.route("/", ${router})`,
      );
    }
  });

  it("states the rule in one place", () => {
    const copies = files.filter((f) => !TOUCHES_THE_BINDING.has(f) && mentions(f, '"apiKeyId"'));

    expect(
      copies,
      `these read apiKeyId off the context themselves instead of asking ${ASKS[0]}. ` +
        "The rule and its reasoning belong in one file; a second copy is how two " +
        "routes came to disagree with the two that asked.",
    ).toEqual([]);
  });

  it.each(Object.keys(HANDLERS_BEYOND_THE_KEY))("is refused by the handler itself: %s", (key) => {
    const handler = handlers.find((h) => h.key === key);
    expect(handler, `${key} is no longer registered`).toBeDefined();
    expect(
      ASKS.some((name) => handler!.body.includes(name)),
      `${key} creates access a revoked key would leave behind and does not refuse a key itself`,
    ).toBe(true);
    expect(
      HANDLERS_BEYOND_THE_KEY[key].length,
      `${key}'s reason is too short to be one`,
    ).toBeGreaterThan(30);
  });

  it.each([...TOUCHES_THE_BINDING.keys()])("still needs to name the binding: %s", (file) => {
    expect(files, `${file} is allowlisted but no longer exists`).toContain(file);
    expect(
      mentions(file, "apiKeyId"),
      `${file} no longer names apiKeyId — remove it from TOUCHES_THE_BINDING`,
    ).toBe(true);
  });
});
