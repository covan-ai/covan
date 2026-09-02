/**
 * The four Slack calls this integration makes, and no client library.
 *
 * Slack's own SDK is a large dependency that assumes Node, and what we need
 * from it is four `fetch` calls with a bearer token. The one thing worth
 * knowing about the Web API is below: it answers **200 with `ok: false`** for
 * application errors, so a caller that checks `res.ok` and stops has just
 * silently ignored `invalid_auth`.
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

async function call(
  fetchImpl: typeof fetch,
  method: string,
  token: string,
  body: Record<string, unknown>,
): Promise<SlackResponse> {
  const res = await fetchImpl(`${API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
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
 * Not `call` above, because this one is the exception: it is a form post with
 * the client credentials rather than a JSON post with a bearer token, since
 * there is no token yet — that is what it is for.
 */
export async function exchangeSlackCode(
  fetchImpl: typeof fetch,
  env: { SLACK_CLIENT_ID?: string; SLACK_CLIENT_SECRET?: string },
  code: string,
  redirectUri: string,
): Promise<{ botToken: string; teamId: string; teamName: string; botUserId: string }> {
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
    if (err instanceof SlackError && (err.code === "missing_scope" || err.code === "users_not_found")) {
      return null;
    }
    throw err;
  }
}
