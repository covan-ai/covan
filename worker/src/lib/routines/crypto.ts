/**
 * Delivery secrets (Slack webhook URLs, destination addresses) are encrypted
 * with AES-GCM before they touch Postgres, using a key held as a Worker
 * secret. Combined with the column-level grant on `delivery_channels`, a
 * database dump on its own is worthless.
 */

const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function importKey(keyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromB64(keyB64), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * The envelope version. It costs three characters per row and it is the only
 * thing that makes rotating ROUTINE_SECRET_KEY survivable later: a reader can
 * tell which key a row was written with instead of discovering the answer as
 * five decrypt failures and an auto-paused routine.
 */
const VERSION = "v1";

/** Returns `v1.<iv-base64>.<ciphertext-base64>`. */
export async function encryptSecret(plaintext: string, keyB64: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${VERSION}.${toB64(iv)}.${toB64(new Uint8Array(ct))}`;
}

/** Throws if the payload was tampered with or the key is wrong — AES-GCM is authenticated. */
export async function decryptSecret(payload: string, keyB64: string): Promise<string> {
  const [version, ivB64, ctB64] = payload.split(".");
  // Rejected loudly rather than guessed at: an unknown version means a payload
  // this build cannot read, and silently trying v1 rules on it would surface as
  // an unexplained decrypt failure instead of a clear one.
  if (version !== VERSION) {
    throw new Error(`unsupported secret payload version: ${version || "(none)"}`);
  }
  if (!ivB64 || !ctB64) throw new Error("malformed secret payload");
  const key = await importKey(keyB64);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(ivB64) },
    key,
    fromB64(ctB64),
  );
  return new TextDecoder().decode(plain);
}

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
