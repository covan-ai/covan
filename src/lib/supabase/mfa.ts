import type { Factor } from "@supabase/supabase-js";
import { supabase } from "./client";

/**
 * Two-step sign-in, in the few calls the pages make.
 *
 * Supabase Auth keeps the factors; this file only decides which of them the
 * app talks about. Only authenticator apps (TOTP): no SMS, which costs money
 * per message and is the weakest second factor there is, and no backup codes,
 * which Supabase does not have — losing the phone is answered by a second
 * device, or by whoever runs the deployment removing the factor (see
 * docs/self-hosting.md).
 *
 * Whether a session still owes its second step is `readSession()`'s question,
 * not this file's.
 */

/** The authenticators that count — verified ones. */
export async function verifiedAuthenticators(): Promise<Factor[]> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  return data.totp;
}

/**
 * Turn a session that is one code short into a whole one.
 *
 * Any verified authenticator will do, so a person with two devices can use
 * whichever is in their hand: each is tried until one accepts the code. GoTrue
 * rate-limits verification attempts on its own.
 */
export async function giveSecondFactor(code: string): Promise<void> {
  const factors = await verifiedAuthenticators();
  if (factors.length === 0) throw new Error("This account has no authenticator to check against.");

  let lastError: Error | null = null;
  for (const factor of factors) {
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
    if (!error) return;
    lastError = error;
  }
  throw lastError ?? new Error("That code did not match.");
}

export type Enrollment = { factorId: string; qrCode: string; secret: string };

/**
 * Begin adding an authenticator. Nothing is switched on until `confirmEnrollment`.
 *
 * Unfinished ones are cleared first. A dialog closed halfway leaves an
 * unverified factor behind, and GoTrue refuses a second with the same name, so
 * without this a person who abandoned setup once could not start it again.
 */
export async function startEnrollment(deviceName: string): Promise<Enrollment> {
  const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
  if (listError) throw listError;
  for (const factor of factors.all) {
    if (factor.status === "unverified") {
      await supabase.auth.mfa.unenroll({ factorId: factor.id });
    }
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    issuer: "Covan",
    friendlyName: deviceName,
  });
  if (error) throw error;
  return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
}

/** The first code from the new authenticator; the factor counts from here on. */
export async function confirmEnrollment(factorId: string, code: string): Promise<void> {
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) throw error;
}

/** A setup abandoned before its first code. Best effort: `startEnrollment` sweeps too. */
export async function abandonEnrollment(factorId: string): Promise<void> {
  await supabase.auth.mfa.unenroll({ factorId });
}

/**
 * Remove an authenticator. GoTrue only allows this from a session that has
 * already given a second factor, so a stolen password cannot take it off.
 * Removing the last one turns two-step sign-in off.
 */
export async function removeAuthenticator(factorId: string): Promise<void> {
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) throw error;
}
