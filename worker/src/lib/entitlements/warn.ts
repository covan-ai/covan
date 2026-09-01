import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { quotaLowEmail } from "../emails/quota";
import { appUrlOf, notify } from "../emails/send";

/**
 * How spent an allowance has to be before it is worth saying so.
 *
 * The same three quarters `src/lib/quota.ts` has used to render its "low" state
 * since it was written. One number for one idea: a screen that says low while a
 * mailbox stays silent, or the reverse, is two different answers to "am I about
 * to run out".
 */
export const WARN_AT = 0.75;

/**
 * Whether two timestamps name the same moment, whatever they are spelled like.
 *
 * An unparseable or missing value answers false — "we have not warned yet" — so
 * a corrupt stamp costs one extra message rather than silencing the warning for
 * good.
 */
function sameInstant(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) && left === right;
}

/**
 * Say something before the allowance is gone, once per period.
 *
 * Until this existed the first news anybody had of their quota was `guardQuota`
 * answering 402 in the middle of a conversation — a refusal is a poor way to
 * learn a limit exists. This is the same event announced early enough to do
 * something about.
 *
 * Three properties, and all three are the point:
 *
 * - **Once.** Being over the threshold stays true for every request afterwards,
 *   so a message per reply is what the naive version does. `quota_warned_for`
 *   holds the period this already fired for and is compared for equality — a
 *   new period brings a new reset time, so exactly one warning goes out.
 * - **Silent when unmetered.** `limit: null` is what the open build's
 *   `unlimitedEntitlements` answers. A self-hosted Covan brings its own OpenAI
 *   key and has no allowance, so there is nothing to warn about and this returns
 *   before it reads anything.
 * - **Never throws.** It is called after the work is done and the reply is on
 *   its way. Every failure path here is a message not sent, never a request
 *   turned into an error.
 */
export async function warnIfLow(c: Context<AppEnv>): Promise<void> {
  try {
    const user = c.get("user");
    if (!user?.email) return;

    const { used, limit, resetsAt } = await c.get("entitlements").snapshot(user.id);
    if (limit === null || limit <= 0 || !resetsAt) return;
    if (used / limit < WARN_AT) return;

    const db = c.get("db");
    const { data: prefs } = await db
      .from("notification_preferences")
      .select("quota_exhausted, quota_warned_for")
      .eq("user_id", user.id)
      .maybeSingle();

    // A missing row means every notice is on — the rule `0015` set and the one
    // that keeps somebody who has never opened the settings screen hearing about
    // their own allowance.
    if (prefs?.quota_exhausted === false) return;

    // Compared as instants, not as text. The column is a `timestamptz`: it is
    // written from `toISOString()` — `…T00:00:00.000Z` — and PostgREST returns
    // it as `…T00:00:00+00:00`. The same moment spelled two ways, so `===` is
    // always false and the warning would fire on every reply for the rest of
    // the period, which is precisely what the column was added to prevent.
    if (sameInstant(prefs?.quota_warned_for as string | null | undefined, resetsAt)) return;

    // Stamped before the send rather than after it. The two orders fail
    // differently: this way a Resend outage costs one missed warning, while the
    // other way round it costs a message per reply for the rest of the period.
    const { error } = await db
      .from("notification_preferences")
      .upsert(
        { user_id: user.id, quota_warned_for: resetsAt, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
    if (error) return;

    notify(c, quotaLowEmail({ email: user.email, used, limit, resetsAt, appUrl: appUrlOf(c) }));
  } catch (err) {
    console.error("failed to check whether a quota warning was due", err);
  }
}
