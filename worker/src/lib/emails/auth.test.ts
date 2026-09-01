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
  it("covers the two flows the app actually uses", () => {
    expect(authEmailTemplates.map((t) => t.filename)).toEqual([
      "confirm-signup.html",
      "reset-password.html",
    ]);
  });

  // Supabase substitutes these server-side. Get the name wrong and the button
  // renders as an empty href — a mail that looks finished and goes nowhere.
  it("gives every template a working confirmation link", () => {
    for (const template of authEmailTemplates) {
      expect(template.html, template.filename).toContain("{{ .ConfirmationURL }}");
    }
  });

  it("renders each one in the Covan shell", () => {
    for (const template of authEmailTemplates) {
      expect(template.html, template.filename).toContain("<!doctype html>");
      expect(template.html, template.filename).toContain("Covan");
    }
  });
});
