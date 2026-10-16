/**
 * The Slack calls this integration makes, and no client library.
 *
 * Slack's own SDK is a large dependency that assumes Node, and what we need
 * from it is a handful of `fetch` calls with a bearer token. The one thing worth
 * knowing about the Web API is below: it answers **200 with `ok: false`** for
 * application errors, so a caller that checks `res.ok` and stops has just
 * silently ignored `invalid_auth`. The other is in `call`: arguments go as a
 * form, not JSON.
 */

const API = "https://slack.com/api";

export class SlackError extends Error {
  /** Slack's own error code, e.g. `invalid_auth`, `channel_not_found`. */
  readonly code: string;
  constructor(method: string, code: string) {
    super(`slack ${method} failed: ${code}`);
    this.name = "SlackError";
    this.code = code;
  }
}

type SlackResponse = { ok?: boolean; error?: string; [key: string]: unknown };

/** One argument, as a form field. Every one this file sends is a scalar. */
type SlackArg = string | number | boolean | undefined;

/**
 * One Web API call, its arguments posted as a form.
 *
 * Not JSON. Slack reads a JSON body only on its write methods; the read ones —
 * `users.info`, `conversations.info`, `conversations.history`,
 * `chat.getPermalink` — ignore it, so the `user` or `channel` never arrives and
 * the answer is `user_not_found` for somebody who plainly exists. That was every
 * Slack question, and every Slack routine, until this was a form. A form is
 * read by every method, writes included.
 */
async function call(
  fetchImpl: typeof fetch,
  method: string,
  token: string,
  args: Record<string, SlackArg>,
): Promise<SlackResponse> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) form.set(key, String(value));
  }
  const res = await fetchImpl(`${API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  // A transport failure is still a failure worth naming, even though the line
  // below catches almost everything.
  if (!res.ok) throw new SlackError(method, `http_${res.status}`);
  const data = (await res.json()) as SlackResponse;
  if (!data.ok) throw new SlackError(method, String(data.error ?? "unknown"));
  return data;
}

/**
 * Finish an install.
 *
 * Not `call` above, because this one is the exception: it carries the client
 * credentials rather than a bearer token, since there is no token yet — that
 * is what it is for.
 */
export async function exchangeSlackCode(
  fetchImpl: typeof fetch,
  env: { SLACK_CLIENT_ID?: string; SLACK_CLIENT_SECRET?: string },
  code: string,
  redirectUri: string,
): Promise<{
  botToken: string;
  teamId: string;
  teamName: string;
  botUserId: string;
  /** What Slack granted, which an admin can make less than what was asked for. */
  scopes: string[];
}> {
  const res = await fetchImpl(`${API}/oauth.v2.access`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.SLACK_CLIENT_ID ?? "",
      client_secret: env.SLACK_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri,
    }),
  });
  const data = (await res.json()) as SlackResponse & {
    access_token?: string;
    bot_user_id?: string;
    scope?: string;
    team?: { id?: string; name?: string };
  };
  if (!data.ok) throw new SlackError("oauth.v2.access", String(data.error ?? "unknown"));
  if (!data.access_token || !data.team?.id || !data.bot_user_id) {
    throw new SlackError("oauth.v2.access", "incomplete_install");
  }
  return {
    botToken: data.access_token,
    teamId: data.team.id,
    teamName: data.team.name ?? data.team.id,
    botUserId: data.bot_user_id,
    scopes: (data.scope ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/**
 * Post into a thread.
 *
 * `thread_ts` is always set, so a reply is a reply. Answering in the channel
 * instead would put a wall of retrieved text in front of everyone, which is the
 * quickest way to have an integration muted.
 */
export async function postMessage(
  fetchImpl: typeof fetch,
  token: string,
  message: { channel: string; threadTs: string; text: string },
): Promise<void> {
  await call(fetchImpl, "chat.postMessage", token, {
    channel: message.channel,
    thread_ts: message.threadTs,
    text: message.text,
    // Slack renders a link preview for every URL in a citation list otherwise,
    // and a reply that cites four documents becomes four cards nobody asked for.
    unfurl_links: false,
    unfurl_media: false,
  });
}

/** The email Slack holds for a user, or null when the app was not granted it. */
export async function lookupEmail(
  fetchImpl: typeof fetch,
  token: string,
  slackUserId: string,
): Promise<string | null> {
  try {
    const data = await call(fetchImpl, "users.info", token, { user: slackUserId });
    const profile = (data.user as { profile?: { email?: string } } | undefined)?.profile;
    return profile?.email?.trim().toLowerCase() || null;
  } catch (err) {
    // `missing_scope` is the common one, and it is a configuration answer
    // rather than a failure of this request: an app installed without
    // users:read.email cannot identify anybody, and the caller turns that into
    // a message a person can act on.
    if (
      err instanceof SlackError &&
      (err.code === "missing_scope" || err.code === "user_not_found")
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Whether a channel is one the whole Slack workspace can read.
 *
 * `false` for a private channel, a group DM or a DM, and for any channel Slack
 * will not describe — `missing_scope` from an install made before
 * `channels:read` was requested, `channel_not_found` for a private channel this
 * app has no `groups:read` for. The caller decides who in Covan sees the
 * conversation by this answer, and "not known to be public" is private.
 */
export async function isPublicChannel(
  fetchImpl: typeof fetch,
  token: string,
  channel: string,
): Promise<boolean> {
  try {
    const data = await call(fetchImpl, "conversations.info", token, { channel });
    const info = data.channel as
      | { is_channel?: boolean; is_private?: boolean; is_im?: boolean; is_mpim?: boolean }
      | undefined;
    return Boolean(info?.is_channel && !info.is_private && !info.is_im && !info.is_mpim);
  } catch (err) {
    if (err instanceof SlackError) return false;
    throw err;
  }
}

// ---- for routines that start on Slack activity (0112) ----------------------

export type SlackChannel = { id: string; name: string; isMember: boolean | null };

/** A channel id as Slack writes one: C… for public, G… for an older private one. */
const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;

/**
 * The channel a person named — `#general`, `general`, or an id pasted from the
 * channel's details — or null when this install cannot see it.
 *
 * An id is described with `conversations.info`; a name is looked for in the
 * public channels (`conversations.list`, a few pages at most: a workspace with
 * thousands of channels is asked to paste the id instead). `isMember` is null
 * where Slack would not say, which is a private channel this app was not
 * granted `groups:read` for — the person pasted its id, and the app is either
 * in it, in which case events arrive, or not, in which case they never will.
 */
export async function findChannel(
  fetchImpl: typeof fetch,
  token: string,
  named: string,
): Promise<SlackChannel | null> {
  const wanted = named.trim().replace(/^#/, "");
  if (CHANNEL_ID.test(wanted)) {
    try {
      const data = await call(fetchImpl, "conversations.info", token, { channel: wanted });
      const info = data.channel as { id?: string; name?: string; is_member?: boolean } | undefined;
      return {
        id: info?.id ?? wanted,
        name: info?.name ?? wanted,
        isMember: typeof info?.is_member === "boolean" ? info.is_member : null,
      };
    } catch (err) {
      if (err instanceof SlackError && err.code === "missing_scope") {
        return { id: wanted, name: wanted, isMember: null };
      }
      if (err instanceof SlackError && err.code === "channel_not_found") return null;
      throw err;
    }
  }

  const name = wanted.toLowerCase();
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const data = await call(fetchImpl, "conversations.list", token, {
      types: "public_channel",
      exclude_archived: true,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    const channels = (data.channels ?? []) as Array<{
      id: string;
      name: string;
      is_member?: boolean;
    }>;
    const hit = channels.find((ch) => ch.name.toLowerCase() === name);
    if (hit) return { id: hit.id, name: hit.name, isMember: hit.is_member ?? null };
    cursor = (data.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
    if (!cursor) break;
  }
  return null;
}

/** How a person is shown in Slack, or null when Slack will not say. */
export async function displayName(
  fetchImpl: typeof fetch,
  token: string,
  slackUserId: string,
): Promise<string | null> {
  try {
    const data = await call(fetchImpl, "users.info", token, { user: slackUserId });
    const user = data.user as
      | {
          real_name?: string;
          name?: string;
          profile?: { display_name?: string; real_name?: string };
        }
      | undefined;
    return (
      user?.profile?.display_name?.trim() ||
      user?.profile?.real_name?.trim() ||
      user?.real_name?.trim() ||
      user?.name?.trim() ||
      null
    );
  } catch (err) {
    if (err instanceof SlackError) return null;
    throw err;
  }
}

/** A link to one message, or null. */
export async function permalink(
  fetchImpl: typeof fetch,
  token: string,
  channel: string,
  ts: string,
): Promise<string | null> {
  try {
    const data = await call(fetchImpl, "chat.getPermalink", token, { channel, message_ts: ts });
    return typeof data.permalink === "string" ? data.permalink : null;
  } catch (err) {
    if (err instanceof SlackError) return null;
    throw err;
  }
}

/**
 * The text of one message, for a reaction to it: a reaction event says only
 * which message, not what it said. Null when Slack will not say — a thread
 * reply `conversations.history` does not list, or a channel the app left.
 */
export async function messageText(
  fetchImpl: typeof fetch,
  token: string,
  channel: string,
  ts: string,
): Promise<{ text: string; user: string | null } | null> {
  try {
    const data = await call(fetchImpl, "conversations.history", token, {
      channel,
      latest: ts,
      inclusive: true,
      limit: 1,
    });
    const message = (
      (data.messages ?? []) as Array<{ ts?: string; text?: string; user?: string }>
    )[0];
    if (!message || message.ts !== ts) return null;
    return { text: message.text ?? "", user: message.user ?? null };
  } catch (err) {
    if (err instanceof SlackError) return null;
    throw err;
  }
}
