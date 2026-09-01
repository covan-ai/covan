import { escapeHtml } from "./escape-html";

/**
 * The chrome every Covan mail shares.
 *
 * Built to DESIGN.md rather than to a mail template's habits: warm neutrals with
 * one amber accent used as a pointer, ink for the primary button (§1, the amber
 * lives in a chip and never in a button), squares rather than circles (§3), and
 * the 8px card radius from the radius ladder.
 *
 * Three constraints come from the medium rather than the design system:
 *
 * - **Every rule is inline.** A `<style>` block is dropped by enough clients
 *   that anything load-bearing has to sit on the element it styles. The one
 *   `<style>` here carries the dark-mode overrides only, so a client that
 *   discards it still gets the light design rather than an unstyled page.
 * - **Tables, not divs.** Outlook renders through Word, which does not lay out
 *   with flexbox or grid. A centred single-column table is what works there and
 *   costs nothing anywhere else.
 * - **No external images.** No logo from a CDN and no tracking pixel, so nothing
 *   depends on "load remote content" being clicked, and a mail nobody opens
 *   stays a mail nobody opened rather than a datapoint.
 */

const PAPER = "#f7f7f4";
const CARD = "#ffffff";
const HAIRLINE = "#e8e6dd";
const INK = "#251f19";
const MUTED = "#6b6157";
const AMBER = "#f48d16";

// DM Sans does every display job in the app and Geist everything else, but a
// mail client loads neither: a webfont either fails to apply or renders after
// the reader has already seen the fallback. So the stack asks for them in case
// they are installed locally and names the system faces that will actually be
// used.
const DISPLAY = "'DM Sans','Segoe UI',Helvetica,Arial,sans-serif";
const BODY = "Geist,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

export type EmailAction = { label: string; url: string };

export type EmailShellInput = {
  /**
   * The line an inbox shows next to the subject. Worth setting deliberately:
   * left unset, clients quietly use the first words of the body, which for a
   * routine is whatever the model happened to open with.
   */
  preheader: string;
  heading: string;
  /** Already HTML, and therefore never escaped here. */
  bodyHtml: string;
  action?: EmailAction;
  /** Small print under the rule. Plain text; escaped like everything else. */
  footnote?: string;
};

function button(action: EmailAction): string {
  // A table rather than a padded anchor, because Outlook ignores padding on an
  // inline element and would render this as bare underlined text.
  return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px">
        <tr>
          <td class="btn" style="background:${INK};border-radius:8px">
            <a href="${escapeHtml(action.url)}" class="btn-label" style="display:inline-block;padding:12px 22px;font-family:${BODY};font-size:15px;font-weight:500;color:${PAPER};text-decoration:none">${escapeHtml(action.label)}</a>
          </td>
        </tr>
      </table>`;
}

export function emailShell(input: EmailShellInput): string {
  const action = input.action ? button(input.action) : "";
  const footnote = input.footnote
    ? `
      <hr style="border:none;border-top:1px solid ${HAIRLINE};margin:28px 0 16px">
      <p style="margin:0;font-family:${BODY};font-size:13px;line-height:1.5;color:${MUTED}">${escapeHtml(input.footnote)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  @media (prefers-color-scheme: dark) {
    /* body as well as the table: the table paints only as far as its own
       height, so a tall window keeps a band of light paper under a dark mail. */
    body, .paper { background: #1a1613 !important; }
    .card { background: #221d19 !important; border-color: #3a322b !important; }
    .ink, .ink *, .wordmark { color: #f2efe9 !important; }
    .muted, .muted a { color: #a89e92 !important; }
    /* DESIGN.md derives the dark ladder in reverse from the same ink and
       inverts the button fill — which is also the only thing that keeps this
       button a shape, since an ink fill on a dark card is ink on ink.
       Ordered after the .ink rule so it wins on the label. */
    .btn { background: #f2efe9 !important; }
    .btn-label { color: #221d19 !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${PAPER}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(input.preheader)}</div>
<table role="presentation" class="paper" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};padding:32px 16px">
  <tr>
    <td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px">
        <tr>
          <td style="padding:0 4px 18px">
            <!-- The wordmark, with the amber as a 10px square mark: a pointer at
                 the smallest size the system uses, nowhere near the 44px ceiling. -->
            <span style="display:inline-block;width:10px;height:10px;background:${AMBER};vertical-align:middle"></span>
            <span class="wordmark" style="font-family:${DISPLAY};font-size:17px;font-weight:600;letter-spacing:-0.01em;color:${INK};vertical-align:middle;padding-left:8px">Covan</span>
          </td>
        </tr>
        <tr>
          <td class="card ink" style="background:${CARD};border:1px solid ${HAIRLINE};border-radius:8px;padding:32px 28px">
            <h1 style="margin:0 0 18px;font-family:${DISPLAY};font-size:22px;font-weight:600;line-height:1.25;letter-spacing:-0.01em;color:${INK}">${escapeHtml(input.heading)}</h1>
            <div style="font-family:${BODY}">${input.bodyHtml}</div>
            ${action}
            ${footnote}
          </td>
        </tr>
        <tr>
          <td class="muted" style="padding:18px 4px 0;font-family:${BODY};font-size:12px;line-height:1.5;color:${MUTED}">
            Sent by Covan · <a href="https://covan.app" style="color:${MUTED}">covan.app</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}
