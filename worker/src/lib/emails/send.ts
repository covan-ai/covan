import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { deferred } from "../defer";
import { canSendEmail, sendEmail, type Email } from "../email";

/**
 * Send a courtesy email without making the request wait for it, or depend on it.
 *
 * Every caller of this is a route that has already done the thing the email is
 * about: somebody has been removed, an account has been closed, a person has
 * joined. The message is a courtesy, and a courtesy must not be able to fail the
 * operation it describes — nor delay a response while Resend is slow. So this
 * checks configuration, defers past the response, and swallows the outcome.
 *
 * `deferred` is what makes that safe on Workers, where work started and not
 * awaited can be cancelled the moment the response is sent.
 *
 * Note what this is NOT for: the invitation email answers `emailed` in its
 * response so the dialog can say what happened, and the routine delivery IS the
 * run rather than a courtesy about it. Both of those wait, and both belong on
 * `sendEmail` directly.
 */
export function notify(c: Context<AppEnv>, email: Email): void {
  if (!canSendEmail(c.env)) return;

  deferred(
    c,
    sendEmail(email, {
      fetchImpl: fetch.bind(globalThis),
      apiKey: c.env.RESEND_API_KEY as string,
      from: c.env.RESEND_FROM as string,
    }),
  );
}

/**
 * The origin to put in a link.
 *
 * `ALLOWED_ORIGIN` is a comma-separated list, because a deployment reachable at
 * more than one origin sets several. The first is the canonical one, and putting
 * the raw variable in a mail would send somebody a URL with a comma in it.
 *
 * `c.env?` for the same reason `canSendEmail` takes an optional env: Hono hands
 * a handler an undefined `env` when no bindings are supplied, which is every
 * route test in this Worker and also a deployment that configures no mail. This
 * is usually evaluated as an argument to a message builder, so it runs *before*
 * `notify` gets to decline — reading through an undefined env here turned a
 * working route into a 500.
 */
export function appUrlOf(c: Context<AppEnv>): string {
  return (c.env?.ALLOWED_ORIGIN ?? "").split(",")[0].trim();
}
