/**
 * Invitation tokens, remembered in this browser between the email and the
 * Accept button.
 *
 * Accepting an invitation takes the token its email carried (migration
 * 0090): holding the email is what proves the invitee is the invitee. The
 * link lands on `/invite`, but whoever opens it is usually not signed in yet —
 * they still have to sign up, perhaps confirm an address, perhaps come back
 * tomorrow — and the Accept button lives inside the app. So the token waits
 * here, keyed by invitation id, until a button asks for it.
 *
 * localStorage rather than sessionStorage, because signing up can mean a
 * confirmation email opened in a new tab. Eight days, one more than an
 * invitation lives, so nothing here outlasts what it unlocks by long. A token
 * is forgotten the moment it is used.
 *
 * Losing it costs nothing worse than opening the email again, so every
 * failure — storage blocked, private window, a parse error — is silent.
 */
const KEY = "covan.invites";
const LIFETIME_MS = 8 * 24 * 60 * 60 * 1000;

type Stash = Record<string, { token: string; at: number }>;

function read(now: number): Stash {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Stash;
    const live: Stash = {};
    for (const [id, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.token === "string" && now - entry.at < LIFETIME_MS) {
        live[id] = entry;
      }
    }
    return live;
  } catch {
    return {};
  }
}

function write(stash: Stash): void {
  try {
    if (Object.keys(stash).length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(stash));
  } catch {
    // Storage blocked: the invitee opens the email again.
  }
}

export function stashInvite(id: string, token: string, now = Date.now()): void {
  write({ ...read(now), [id]: { token, at: now } });
}

export function stashedInviteToken(id: string, now = Date.now()): string | null {
  return read(now)[id]?.token ?? null;
}

export function forgetInvite(id: string, now = Date.now()): void {
  const stash = read(now);
  delete stash[id];
  write(stash);
}

/**
 * The id and token from an `/invite#id=…&token=…` fragment, or null when the
 * fragment is not one. Both are needed: a token is only ever looked up by the
 * invitation it belongs to.
 */
export function inviteFromFragment(hash: string): { id: string; token: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const id = params.get("id");
  const token = params.get("token");
  return id && token ? { id, token } : null;
}

const LINK_KEY = "covan.invite-link";

/**
 * A workspace's shareable link (`/invite#link=<token>`, 0129). Kept like an
 * email invitation's token — in this browser, for the eight days a link can
 * live — so somebody who opens it signed out finds it waiting once they are in.
 */
export function inviteLinkFromFragment(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("link");
  return token && token.length <= 200 ? token : null;
}

export function stashInviteLink(token: string, now = Date.now()): void {
  try {
    localStorage.setItem(LINK_KEY, JSON.stringify({ token, at: now }));
  } catch {
    // A browser that will not store it loses the convenience, not the link.
  }
}

export function stashedInviteLink(now = Date.now()): string | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(LINK_KEY) ?? "null") as {
      token?: unknown;
      at?: unknown;
    } | null;
    if (!parsed || typeof parsed.token !== "string" || typeof parsed.at !== "number") return null;
    return now - parsed.at < LIFETIME_MS ? parsed.token : null;
  } catch {
    return null;
  }
}

export function forgetInviteLink(): void {
  try {
    localStorage.removeItem(LINK_KEY);
  } catch {
    // Nothing to forget in a browser that never stored it.
  }
}
