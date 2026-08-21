/**
 * The one place that knows how to hand an email to Resend.
 *
 * Two callers, and they want opposite things from a failure. A routine's
 * delivery failing is the whole point of the run and has to be recorded against
 * it; an invitation email failing must not undo the invitation, which is a row
 * in the database and exists whether or not anybody was told about it. So this
 * returns the Response rather than throwing, and each caller decides what a
 * non-2xx means. Sharing the *request* — the endpoint, the auth header, `to` as
 * an array, the exact body keys — is what is worth having in one file; sharing
 * the reaction is not.
 */

export type EmailDeps = {
  fetchImpl: typeof fetch;
  apiKey: string;
  from: string;
};

export type Email = {
  to: string;
  subject: string;
  text: string;
};

/**
 * Whether this deployment can send mail at all.
 *
 * RESEND_API_KEY and RESEND_FROM are both optional — a self-hosted Covan that
 * never sets them is a supported configuration, not a broken one. Callers check
 * this first so they can say "no email was sent" honestly, rather than posting
 * to Resend with an empty bearer token and reporting whatever 401 comes back as
 * though something had gone wrong.
 */
export function canSendEmail(env?: { RESEND_API_KEY?: string; RESEND_FROM?: string }): boolean {
  // Optional rather than required: Hono hands a handler an undefined `env` when
  // no bindings are supplied, which is every route test in this worker. A
  // deployment with no mail configured and a test with no bindings want the
  // same answer, and neither wants a TypeError.
  return Boolean(env?.RESEND_API_KEY && env?.RESEND_FROM);
}

export function sendEmail(email: Email, deps: EmailDeps): Promise<Response> {
  return deps.fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deps.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: deps.from,
      to: [email.to],
      subject: email.subject,
      text: email.text,
    }),
  });
}
