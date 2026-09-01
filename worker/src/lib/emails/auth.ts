import { emailShell } from "../email-layout";

/**
 * The two mails Supabase sends on this product's behalf.
 *
 * Nothing in this Worker sends them — GoTrue does, from templates stored in the
 * hosted project. They are written here anyway, in the same shell as every other
 * Covan mail, because the confirmation is the first thing a new account ever
 * receives and Supabase's default is an unstyled sentence and a bare link.
 *
 * `{{ .ConfirmationURL }}` is substituted by Supabase, not by us. It is written
 * into the `action` URL and therefore passes through the shell's escaping —
 * harmless, since the braces and dots it is made of are not characters that
 * escaping touches.
 *
 * To use them: `supabase/templates/*.html` holds the rendered files, and
 * Authentication → Emails in the dashboard is where they are pasted. See
 * `docs/self-hosting.md`.
 */

const P = "margin:0 0 16px;font-size:15px;line-height:1.55;color:#251f19";

export const authEmailTemplates = [
  {
    filename: "confirm-signup.html",
    subject: "Confirm your Covan address",
    html: emailShell({
      preheader: "Confirm your address to activate your Covan account.",
      heading: "Confirm your address",
      bodyHtml: [
        `<p style="${P}">You are one click from a Covan account. Confirming tells us the address is really yours — after that you can sign in.</p>`,
        `<p style="${P}">If a colleague invited you, the invitation is matched to this address and will be waiting once you are in.</p>`,
      ].join(""),
      action: { label: "Confirm my address", url: "{{ .ConfirmationURL }}" },
      footnote: "If you did not create a Covan account, you can ignore this — nothing was set up.",
    }),
  },
  {
    filename: "reset-password.html",
    subject: "Reset your Covan password",
    html: emailShell({
      preheader: "A link to choose a new Covan password.",
      heading: "Reset your password",
      bodyHtml: [
        `<p style="${P}">Somebody asked for a new password on the Covan account at this address. The link below opens the page where you can choose one.</p>`,
        // Said plainly because the honest answer to "did someone try to get into
        // my account?" is that a reset request proves nothing about them
        // succeeding — and the reassurance is only true while the old password
        // still works, which it does until this link is used.
        `<p style="${P}">The link expires, and your current password keeps working until you set a new one.</p>`,
      ].join(""),
      action: { label: "Choose a new password", url: "{{ .ConfirmationURL }}" },
      footnote:
        "If this was not you, ignore this message — your password has not changed and nobody was let in.",
    }),
  },
  {
    // Supabase can send this and does not by default: it is
    // `auth.email.notification.password_changed`, off until somebody turns it
    // on. Worth turning on. It is the only message in the whole set that a
    // person reads in order to find out they have been broken into — a password
    // change nobody asked for is the first evidence of a stolen session, and
    // silence there is the difference between an hour and a month.
    //
    // No button, and deliberately: it announces something already done. A link
    // in a mail about credentials is also exactly the shape of the phishing this
    // message would otherwise help somebody fall for.
    filename: "password-changed.html",
    subject: "Your Covan password was changed",
    html: emailShell({
      preheader: "The password on your Covan account was just changed.",
      heading: "Your password was changed",
      bodyHtml: [
        `<p style="${P}">The password on your Covan account has just been changed, and the new one is in use from now on.</p>`,
        `<p style="${P}">If that was you, there is nothing to do.</p>`,
        `<p style="${P}"><strong>If it was not you</strong>, somebody else has access to this account. Use "Forgot password" on the sign-in page to take it back — that sends a link to this address, which they cannot read.</p>`,
      ].join(""),
    }),
  },
];
