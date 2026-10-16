import { emailShell } from "../email-layout";

/**
 * The mails Supabase sends on this product's behalf.
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
        `<p style="${P}">You are one click from a Covan account. Confirming tells us the address is really yours, and the link brings you back to Covan signed in.</p>`,
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
    // Sent when somebody changes their address from the account page. With
    // `double_confirm_changes` on — the default, and this project's setting —
    // GoTrue sends this same template to BOTH addresses and changes nothing
    // until both links are followed, so the copy has to read correctly to the
    // old inbox and the new one alike. That is why it names the new address
    // rather than saying "this address", and why it says the other link exists.
    //
    // The old inbox is also the one a hijacker cannot read, which makes this the
    // mail that stops a stolen session from moving the account somewhere else.
    // The footnote says so in the plainest terms it can.
    filename: "change-email.html",
    subject: "Confirm your new Covan address",
    html: emailShell({
      preheader: "Confirm the change to the address on your Covan account.",
      heading: "Confirm your new address",
      bodyHtml: [
        `<p style="${P}">Somebody asked to move the Covan account at {{ .Email }} to <strong>{{ .NewEmail }}</strong>.</p>`,
        `<p style="${P}">A link like this one went to both addresses. The change happens once both have been followed, and until then you keep signing in as before.</p>`,
      ].join(""),
      action: { label: "Confirm the change", url: "{{ .ConfirmationURL }}" },
      footnote:
        "If you did not ask for this, do not follow the link — without it the address stays as it is. Changing your password is the safe next step.",
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
    // The code a password change asks for when the session is more than a day
    // old (`secure_password_change`, components/account/password-card.tsx).
    // GoTrue calls it Reauthentication and fills in `{{ .Token }}`. A code and
    // not a link: the person is standing in account settings with a field
    // waiting for it, and a link would open a second tab that knows nothing of
    // the password they just typed.
    filename: "reauthentication.html",
    subject: "Your Covan confirmation code",
    html: emailShell({
      preheader: "The code to confirm a change to your Covan account.",
      heading: "Confirm it is you",
      bodyHtml: [
        `<p style="${P}">You are changing the password on your Covan account. Enter this code where Covan asked for it:</p>`,
        `<p style="margin:0 0 16px;font-size:28px;line-height:1.2;letter-spacing:6px;font-weight:600;color:#251f19">{{ .Token }}</p>`,
      ].join(""),
      footnote:
        "If you are not changing your password, somebody else may be signed in to your account. Do not share this code; change your password from the sign-in page instead.",
    }),
  },
  {
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
