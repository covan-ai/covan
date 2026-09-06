/**
 * At-rest encryption for a workspace's provider keys.
 *
 * AES-256-GCM through WebCrypto, which is available on Workers and in Node
 * without a dependency. GCM rather than CBC because it authenticates as well as
 * encrypts: a ciphertext somebody has edited fails to decrypt rather than
 * decrypting to something else.
 *
 * The IV is fresh per encryption and stored in plain beside the ciphertext,
 * which is what GCM expects — an IV is a uniqueness requirement, not a secret.
 * Reusing one under the same key is the mistake that breaks GCM, so it is
 * generated here and never passed in.
 */

/** AES-256. `PROVIDER_KEY_SECRET` must decode to exactly this many bytes. */
export const SECRET_BYTES = 32;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function keyFrom(secret: string): Promise<CryptoKey> {
  const raw = fromBase64(secret);
  if (raw.byteLength !== SECRET_BYTES) {
    throw new Error(`PROVIDER_KEY_SECRET must decode to ${SECRET_BYTES} bytes`);
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(
  secret: string,
  plaintext: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await keyFrom(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: toBase64(new Uint8Array(sealed)), iv: toBase64(iv) };
}

/**
 * `null` rather than a throw on every failure — a wrong secret, a rotated
 * secret, a corrupted row, a malformed base64.
 *
 * This is called in the middle of a chat request for somebody who has already
 * run out of allowance. A throw here would turn "we could not open your key"
 * into a 500 on a reply they were owed; `null` turns it into a fall back to the
 * operator's key, which is the same answer every other failure in this feature
 * gives.
 */
export async function decryptSecret(
  secret: string,
  ciphertext: string,
  iv: string,
): Promise<string | null> {
  try {
    const key = await keyFrom(secret);
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(iv) },
      key,
      fromBase64(ciphertext),
    );
    return new TextDecoder().decode(opened);
  } catch {
    return null;
  }
}

/**
 * What an admin sees instead of the key they set.
 *
 * Enough to answer "is this the key I meant" — the shape at the front and the
 * last four — and not enough to be worth capturing. There is no endpoint that
 * returns more than this.
 */
export function hintFor(key: string): string {
  if (key.length <= 7) return key;
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
