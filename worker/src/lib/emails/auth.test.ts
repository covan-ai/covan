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
      "password-changed.html",
    ]);
  });

  // Supabase substitutes this server-side. Get the name wrong and the button
  // renders as an empty href — a mail that looks finished and goes nowhere.
  it.each(["confirm-signup.html", "reset-password.html"])(
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

  it("renders each one in the Covan shell", () => {
    for (const template of authEmailTemplates) {
      expect(template.html, template.filename).toContain("<!doctype html>");
      expect(template.html, template.filename).toContain("Covan");
    }
  });
});
