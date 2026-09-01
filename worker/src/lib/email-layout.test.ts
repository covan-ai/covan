import { describe, expect, it } from "vitest";
import { emailShell } from "./email-layout";

/**
 * The chrome every Covan mail shares: the paper background, the raised card,
 * the wordmark and the one ink button.
 *
 * `bodyHtml` arrives already rendered — from `email-markdown` for a routine, or
 * written by hand for an invitation — so the shell never escapes it. Everything
 * the shell is handed as *text* it must escape itself, and the first test is
 * that one: a heading carries a workspace name, which is whatever somebody
 * typed into a form.
 */
describe("emailShell", () => {
  it("escapes the text it is given, and not the HTML body it is handed", () => {
    const html = emailShell({
      preheader: "A preheader",
      heading: "<script>alert(1)</script> invited you",
      bodyHtml: "<p>Already HTML.</p>",
    });

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<p>Already HTML.</p>");
  });

  it("renders an action as a link to its destination", () => {
    const html = emailShell({
      preheader: "p",
      heading: "h",
      bodyHtml: "",
      action: { label: "Sign in to accept", url: "https://covan.app" },
    });

    expect(html).toContain('href="https://covan.app"');
    expect(html).toContain("Sign in to accept");
  });

  // A routine's digest has nowhere in particular to send anybody, so the shell
  // has to come without a button rather than with an empty one.
  it("renders no button when there is no action", () => {
    const html = emailShell({ preheader: "p", heading: "h", bodyHtml: "<p>x</p>" });

    // The footer's covan.app link is the only anchor a button-less mail has.
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  /**
   * Found by rendering these in a dark browser rather than by reading them.
   *
   * An ink button on a dark card is ink on ink: the fill stops being a shape and
   * the mail loses its only call to action. DESIGN.md's dark mode answers this
   * exact question — it derives the ladder in reverse and **inverts the button
   * fill** — so the rule is the product's, not this file's invention. The
   * wordmark and the page behind the card had the same problem, one shade apart.
   */
  it("inverts the button fill in dark mode, and carries the page with it", () => {
    const html = emailShell({
      preheader: "p",
      heading: "h",
      bodyHtml: "",
      action: { label: "Go", url: "https://covan.app" },
    });

    const dark = html.slice(html.indexOf("prefers-color-scheme: dark"), html.indexOf("</style>"));
    expect(dark, "the button fill is not inverted").toMatch(/\.btn\b/);
    expect(dark, "the wordmark is left dark-on-dark").toMatch(/\.wordmark\b/);
    // `body` carries its own background: the outer table only paints as far as
    // its own height, leaving the rest of a tall window in light paper.
    expect(dark, "the page behind the card stays light").toMatch(/\bbody\b/);
  });
});
