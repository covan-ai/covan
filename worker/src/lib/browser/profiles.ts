import { send, type BrowserEnv, type BrowserResult } from "./client";
import { sendV4 } from "./v4";

/**
 * The provider's profiles and standalone browsers.
 *
 * Beside `client.ts` rather than inside it, and for a reason worth stating:
 * `client.ts` is the agent — tasks, their status, stopping them. This is the
 * browser a PERSON drives, and the cookie jar that survives it. They share one
 * header, so they share `send`, and nothing else.
 *
 * **They are on the v4 base** (`sendV4`): the nine `/profiles` and `/browsers`
 * operations are identical in the v2 and v4 documents, so the parsing here is
 * unchanged and only the base moved, to follow `v4.ts`'s runs. The exception is
 * `accountHeadroom`: `/billing/account` exists only in v2 (the provider's docs
 * say to read it there "including when using V4"), so it stays on `send`.
 *
 * **Three of these functions deliberately parse less than the provider
 * returns.** `POST /browsers` answers `liveUrl` AND `cdpUrl`; both are full
 * control of a browser carrying somebody's live sessions, and browser-use says
 * so outright — *"Treat the URL as a credential"*, and view-only embedding is
 * *"a UI restriction, not a server-enforced permission."* So `cdpUrl` is parsed
 * by nothing here, and `browserState`/`stopBrowser` parse neither: a field no
 * function constructs cannot appear in a `console.error`, which is the shape
 * `poller.ts:189-195` uses today and the shape the sweep will want.
 */

/**
 * How long the provider keeps a takeover browser alive.
 *
 * Longer than Covan's own `TAKEOVER_EXPIRY_MINUTES` on purpose — the gap is the
 * only window the sweep has to stop a session cleanly, and a stop is the only
 * thing that saves the cookie jar: *"if a session is left open or times out,
 * changes may not be persisted."* Equal values would give the sweep nothing.
 */
export const TAKEOVER_PROVIDER_MINUTES = 15;

export type ProviderProfile = { id: string; cookieDomains: string[] };
export type ProviderBrowser = {
  id: string;
  status: "active" | "stopped";
  /** Only `createBrowser` and a deliberate re-read ever carry this. Never persisted. */
  liveUrl: string | null;
  timeoutAt: string | null;
};
/** Just enough to say "stopped yet?" without touching a URL. */
export type BrowserStatus = { id: string; status: "active" | "stopped" };
export type BrowserHeadroom = { active: number; limit: number | null };

function domainsOf(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === "string") : [];
}

function statusOf(raw: unknown): "active" | "stopped" {
  // Anything unrecognised reads as `active`, which is the safe direction: a
  // session we wrongly believe is stopped is a browser nobody ever stops.
  return String(raw) === "stopped" ? "stopped" : "active";
}

function toProviderProfile(body: unknown): ProviderProfile {
  const row = (body ?? {}) as Record<string, unknown>;
  return { id: String(row.id ?? ""), cookieDomains: domainsOf(row.cookieDomains) };
}

function toProviderBrowser(body: unknown): ProviderBrowser {
  const row = (body ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id ?? ""),
    status: statusOf(row.status),
    liveUrl: typeof row.liveUrl === "string" && row.liveUrl ? row.liveUrl : null,
    timeoutAt: typeof row.timeoutAt === "string" && row.timeoutAt ? row.timeoutAt : null,
    // `cdpUrl` is not read. See the file header.
  };
}

/**
 * Not `toProviderBrowser` minus two fields — a distinct return type that
 * structurally cannot carry a `liveUrl`. See the file header: the point of a
 * dedicated parser here is that "`browserState`/`stopBrowser` parse no URL"
 * holds because the type they return has nowhere to put one, not because
 * every caller remembers to ignore the field.
 */
function toBrowserStatus(body: unknown): BrowserStatus {
  const row = (body ?? {}) as Record<string, unknown>;
  return { id: String(row.id ?? ""), status: statusOf(row.status) };
}

export function createProfile(
  env: BrowserEnv,
  input: { name?: string; userId?: string },
  opts?: { signal?: AbortSignal },
): Promise<BrowserResult<ProviderProfile>> {
  return sendV4(
    env,
    "/profiles",
    {
      method: "POST",
      // `userId` is the Covan user id, and that is a deliberate concession: a
      // pseudonymous UUID at a subprocessor `docs/security.md` already names,
      // in exchange for being able to find a profile again when auditing one.
      body: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
      },
    },
    opts,
    toProviderProfile,
  );
}

export function getProfile(
  env: BrowserEnv,
  providerProfileId: string,
  opts?: { signal?: AbortSignal },
): Promise<BrowserResult<ProviderProfile>> {
  return sendV4(
    env,
    `/profiles/${encodeURIComponent(providerProfileId)}`,
    { method: "GET", redactBody: true },
    opts,
    toProviderProfile,
  );
}

/** What makes a per-person profile forgettable rather than a one-way door. */
export function deleteProfile(
  env: BrowserEnv,
  providerProfileId: string,
  opts?: { signal?: AbortSignal },
): Promise<BrowserResult<null>> {
  return sendV4(
    env,
    `/profiles/${encodeURIComponent(providerProfileId)}`,
    { method: "DELETE", redactBody: true },
    opts,
    () => null,
  );
}

export function createBrowser(
  env: BrowserEnv,
  input: { profileId: string; proxyCountryCode?: string | null },
  opts?: { signal?: AbortSignal },
): Promise<BrowserResult<ProviderBrowser>> {
  return sendV4(
    env,
    "/browsers",
    {
      method: "POST",
      body: {
        profileId: input.profileId,
        timeout: TAKEOVER_PROVIDER_MINUTES,
        ...(input.proxyCountryCode === undefined
          ? {}
          : { proxyCountryCode: input.proxyCountryCode }),
        // Explicit, and not a default anybody should change to debug
        // something: a recording of this browser is a video of a person
        // typing their password.
        enableRecording: false,
      },
      // The request names a profile id, so the response must not be echoed.
      redactBody: true,
    },
    opts,
    toProviderBrowser,
  );
}

/** Re-read a live browser's URL for its owner. Never persisted; see `routes/browser.ts`. */
export function browserLiveUrl(
  env: BrowserEnv,
  providerSessionId: string,
  opts?: { signal?: AbortSignal },
): Promise<BrowserResult<ProviderBrowser>> {
  return sendV4(
    env,
    `/browsers/${encodeURIComponent(providerSessionId)}`,
    { method: "GET", redactBody: true },
    opts,
    toProviderBrowser,
  );
}

/** "Stopped yet?" — and nothing a log line could leak. */
export function browserState(
  env: BrowserEnv,
  providerSessionId: string,
  opts?: { signal?: AbortSignal },
): Promise<BrowserResult<BrowserStatus>> {
  return sendV4(
    env,
    `/browsers/${encodeURIComponent(providerSessionId)}`,
    { method: "GET", redactBody: true },
    opts,
    toBrowserStatus,
  );
}

/** The call that saves the cookie jar. Parses no URL, for the header's reason. */
export function stopBrowser(
  env: BrowserEnv,
  providerSessionId: string,
  opts?: { signal?: AbortSignal },
): Promise<BrowserResult<BrowserStatus>> {
  return sendV4(
    env,
    `/browsers/${encodeURIComponent(providerSessionId)}`,
    { method: "PATCH", body: { action: "stop" }, redactBody: true },
    opts,
    toBrowserStatus,
  );
}

/**
 * Stop the browser a run declined (ruling R41), best-effort.
 *
 * A run carrying a shared login that was accepted into a session whose stored
 * browser was opened with the person's profile is answered with a fresh,
 * profile-less browser (R38, R40), and the profiled one is left idle at the
 * provider. **Stopping it is also what saves the person's jar**: browser-use,
 * *"always stop the session to persist profile state"* — whatever they signed
 * in to in that browser is not kept until it stops, and an idle one is billed
 * until it does. Stopped by the id the row names and by nothing else: the
 * session's other active browsers are the one the run is in.
 *
 * Never throws and never fails the run it follows: the stop is one
 * subrequest, a refusal logs a status and nothing more (no id, no body), and
 * the sweeps stop every active browser of the session later regardless. A
 * browser already gone (404) is a browser stopped.
 */
export async function stopDeclinedBrowser(
  env: BrowserEnv,
  providerBrowserId: string | null,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  if (!providerBrowserId) return;
  const stopped = await stopBrowser(env, providerBrowserId, opts);
  if (stopped.kind === "error" ? stopped.status !== 404 : stopped.value.status !== "stopped") {
    console.error(
      "could not stop a browser a run declined",
      stopped.kind === "error" ? stopped.status : stopped.value.status,
    );
  }
}

/**
 * How full the shared pool is.
 *
 * The concurrency limit is account-wide across every tenant on one deployment
 * key — ten sessions at $0 lifetime spend — so a takeover that holds a slot for
 * fifteen minutes is fifteen minutes of somebody else's `browse` returning 429.
 * Asked before a slot is taken, which is `composio.ts:264-268`'s rule.
 *
 * Redacted on failure even though the request itself carries no path
 * parameter and no body: the predicate is "does this exchange carry a
 * provider identifier", not "does the request" — and this endpoint's own
 * success body answers `projectId`, a deployment-wide identifier shared by
 * every tenant on the key, which a validation error from it can just as
 * easily echo back on the way out.
 */
export function accountHeadroom(
  env: BrowserEnv,
  opts?: { signal?: AbortSignal },
): Promise<BrowserResult<BrowserHeadroom>> {
  return send(env, "/billing/account", { method: "GET", redactBody: true }, opts, (body) => {
    const row = (body ?? {}) as Record<string, unknown>;
    /**
     * `limit` is **null** when the provider did not answer one, not zero.
     *
     * Zero was the first version and it fails in the worst direction: the
     * caller's test is `active >= limit - POOL_RESERVE`, so `0 >= -2` is true
     * and a renamed field at the provider would make every takeover answer
     * "every browser this deployment can spare is busy" — for ever, with
     * nothing in the logs distinguishing it from a genuinely full pool.
     * Null makes "could not read the limit" a thing the caller must decide
     * about rather than a silent refusal.
     */
    const limit = Number(row.concurrentSessionLimit);
    return {
      active: Number(row.activeSessionCount ?? 0),
      limit: Number.isFinite(limit) && limit > 0 ? limit : null,
    };
  });
}
