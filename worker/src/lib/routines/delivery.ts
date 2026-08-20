import { decryptSecret } from "./crypto";

export type DeliveryChannel = {
  kind: "slack_webhook" | "email";
  secret_ciphertext: string;
};

export type DeliveryDeps = {
  fetchImpl: typeof fetch;
  secretKey: string;
  resendApiKey: string;
  resendFrom: string;
};

/** How much of a failing upstream's body reaches routine_runs.error. */
const MAX_ERROR_BODY = 200;

/** The narrow slice of the Supabase client this module needs. */
export type DeliveryDb = { from: (table: string) => any };

export async function deliver(
  channel: DeliveryChannel,
  message: { subject: string; body: string },
  deps: DeliveryDeps,
): Promise<void> {
  const secret = await decryptSecret(channel.secret_ciphertext, deps.secretKey);

  const res =
    channel.kind === "slack_webhook"
      ? await deps.fetchImpl(secret, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: `*${message.subject}*\n${message.body}` }),
        })
      : await deps.fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${deps.resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: deps.resendFrom,
            to: [secret],
            subject: message.subject,
            text: message.body,
          }),
        });

  if (!res.ok) {
    // Truncated: this string is stored in routine_runs.error and can end up in
    // routines.paused_reason, so an upstream that answers with an HTML error
    // page must not write a megabyte into the database.
    const body = await res.text().catch(() => "");
    throw new Error(`delivery failed: ${res.status} ${body.slice(0, MAX_ERROR_BODY)}`.trim());
  }
}

/**
 * Reserve the items about to be sent. The unique constraint on
 * (routine_id, item_key) means a concurrent or retried run gets back fewer
 * keys — only the ones it actually won — so nothing is delivered twice.
 *
 * Claim-then-send is deliberate. Send-then-record double-sends whenever the
 * record fails, and a duplicate message is the error users actually notice.
 */
export async function claimItemKeys(
  db: DeliveryDb,
  routineId: string,
  keys: string[],
): Promise<string[]> {
  if (keys.length === 0) return [];
  const { data, error } = await db
    .from("routine_deliveries")
    .upsert(
      keys.map((item_key) => ({ routine_id: routineId, item_key })),
      { onConflict: "routine_id,item_key", ignoreDuplicates: true },
    )
    .select("item_key");

  if (error) throw new Error(`claim failed: ${error.message}`);
  return (data ?? []).map((r: { item_key: string }) => r.item_key);
}

/** Hand the keys back after a failed send so the next run retries them. */
export async function releaseItemKeys(
  db: DeliveryDb,
  routineId: string,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;
  const { error } = await db
    .from("routine_deliveries")
    .delete()
    .eq("routine_id", routineId)
    .in("item_key", keys);
  if (error) throw new Error(`release failed: ${error.message}`);
}
