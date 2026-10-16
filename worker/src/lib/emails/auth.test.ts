import { describe, expect, it } from "vitest";
import { authEmailTemplates } from "./auth";

/**
 * Supabase sends the two mails a new account needs — confirm your address, and
 * reset your password — and neither is sent by this Worker. They are pasted into
 * the hosted project's dashboard, which is why they live here as rendered HTML
 * rather than as a function anything calls: written in the same shell as every
 * other Covan mail, so the first message a person ever receives from the product
 * looks like the product.
 *
 * `supabase/templates/` holds the files to paste. `render-auth-templates.test.ts`
 * is what stops those files drifting from this source.
 */
describe("authEmailTemplates", () => {
  it("covers the flows the app actually uses", () => {
    expect(authEmailTemplates.map((t) => t.filename)).toEqual([
      "confirm-signup.html",
      "reset-password.html",
      "change-email.html",
      "reauthentication.html",
      "password-changed.html",
    ]);
  });

  // A code, not a link: the person is already in account settings with a
  // field waiting for it. GoTrue substitutes `{{ .Token }}`; a misspelt name
  // sends a mail with nothing to type.
  it("reauthentication.html carries the code and no link", () => {
    const template = authEmailTemplates.find((t) => t.filename === "reauthentication.html");
    expect(template?.html).toContain("{{ .Token }}");
    expect(template?.html).not.toContain("{{ .ConfirmationURL }}");
  });

  // Supabase substitutes this server-side. Get the name wrong and the button
  // renders as an empty href — a mail that looks finished and goes nowhere.
  it.each(["confirm-signup.html", "reset-password.html", "change-email.html"])(
    "%s asks somebody to follow a link, so it carries one",
    (filename) => {
      const template = authEmailTemplates.find((t) => t.filename === filename);
      expect(template?.html).toContain("{{ .ConfirmationURL }}");
    },
  );

  /**
   * The odd one out, and on purpose.
   *
   * A password-changed notice announces something already done — there is
   * nothing to confirm. It is also the message a person reads at the exact
   * moment they suspect they have been broken into, which is the worst possible
   * moment to have taught them that Covan puts credential links in email. So it
   * names the sign-in page's own "Forgot password" instead of linking anywhere.
   */
  it("puts no link in the message about a password that already changed", () => {
    const changed = authEmailTemplates.find((t) => t.filename === "password-changed.html");
    expect(changed?.html).not.toContain("{{ .ConfirmationURL }}");
    expect(changed?.html).toContain("Forgot password");
  });

  // GoTrue sends the same template to the old address and the new one, so the
  // copy names the new address outright; "this address" would be wrong in one
  // of the two inboxes. `.NewEmail` is GoTrue's variable, substituted like the
  // link — misspelt, it renders empty.
  it("names the address the account is moving to", () => {
    const change = authEmailTemplates.find((t) => t.filename === "change-email.html");
    expect(change?.html).toContain("{{ .NewEmail }}");
  });

  it("renders each one in the Covan shell", () => {
    for (const template of authEmailTemplates) {
      expect(template.html, template.filename).toContain("<!doctype html>");
      expect(template.html, template.filename).toContain("Covan");
    }
  });
});
