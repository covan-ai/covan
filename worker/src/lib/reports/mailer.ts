import type { RoutineEnv } from "../../types";
import { canSendEmail, sendEmail, type Email } from "../email";

/** Sends one email, or is null on a deployment with no mail configured. */
export type Mailer = (email: Email) => Promise<void>;

export function mailerFrom(env: RoutineEnv): Mailer | null {
  if (!canSendEmail(env)) return null;
  return async (email) => {
    const res = await sendEmail(email, {
      fetchImpl: fetch.bind(globalThis),
      apiKey: env.RESEND_API_KEY!,
      from: env.RESEND_FROM!,
    });
    if (!res.ok) throw new Error(`mail refused: ${res.status}`);
  };
}

export function appUrlFrom(env: { ALLOWED_ORIGIN?: string }): string {
  return (env.ALLOWED_ORIGIN ?? "").split(",")[0]!.trim();
}
