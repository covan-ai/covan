/**
 * What a delivery secret looks like once it is safe to show.
 *
 * The encryption itself moved to `lib/secret-box.ts` when connections started
 * storing OAuth tokens under the same key — one envelope format with one
 * reader. What stayed here is the part that is genuinely about delivery
 * channels: turning a webhook URL or an address into something a person can
 * recognise in a list without it being something an onlooker can use.
 */

/**
 * A display-safe hint, computed once at creation time and stored as the
 * channel's label. The full secret is never returned to a client.
 */
export function maskSecret(kind: "slack_webhook" | "email", secret: string): string {
  if (kind === "email") {
    const [local, domain] = secret.split("@");
    const shown = local.length <= 2 ? local : `${local[0]}…${local[local.length - 1]}`;
    return `${shown}@${domain}`;
  }
  const host = new URL(secret).host;
  return `${host}/…${secret.slice(-4)}`;
}
