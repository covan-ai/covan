import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./email-markdown";

/**
 * The small subset of Markdown a routine summary actually arrives in.
 *
 * Nothing constrains that summary's format — `lib/routines/summarise.ts` asks
 * the model for prose and takes whatever comes back — so this converts what
 * models reliably emit (headings, emphasis, lists, links, paragraphs) and
 * leaves everything else as the text it already was.
 *
 * The escaping tests come first and are the reason this file exists at all: the
 * summary is model output derived from fetched web pages, so it is untrusted
 * input on its way into an HTML document.
 */
describe("renderMarkdown", () => {
  it("escapes markup that arrives in the source text", () => {
    const html = renderMarkdown("Watch out for <script>alert(1)</script> in feeds.");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("makes a paragraph of each blank-line-separated block", () => {
    const html = renderMarkdown("First thought.\n\nSecond thought.");

    expect(html).toContain("First thought.</p>");
    expect(html).toContain("Second thought.</p>");
    expect(html.match(/<p[ >]/g)).toHaveLength(2);
  });

  it("renders emphasis rather than printing its asterisks", () => {
    const html = renderMarkdown("Revenue was **up 12%** and *steady*.");

    expect(html).toContain("<strong>up 12%</strong>");
    expect(html).toContain("<em>steady</em>");
    expect(html).not.toContain("**");
  });

  it("turns a hash-prefixed line into a heading", () => {
    const html = renderMarkdown("## What changed\n\nTwo things.");

    expect(html).toContain(">What changed</h2>");
    expect(html).not.toContain("##");
  });

  // Squares, not circles — DESIGN.md §3. The marker is drawn rather than left to
  // the client's own `list-style`, which is a disc everywhere by default.
  it("collects consecutive dash lines into one list", () => {
    const html = renderMarkdown("- First item\n- Second item");

    expect(html.match(/<ul[ >]/g)).toHaveLength(1);
    expect(html.match(/<li[ >]/g)).toHaveLength(2);
    expect(html).toContain("First item");
    expect(html).toContain("square");
  });

  it("renders a markdown link as an anchor", () => {
    const html = renderMarkdown("See [the changelog](https://example.com/changes).");

    expect(html).toContain('href="https://example.com/changes"');
    expect(html).toContain(">the changelog</a>");
  });

  // The link text comes from a page the routine fetched, so the scheme is the
  // attacker-controlled part. Anything but http(s) keeps its brackets and stays
  // text — visible, inert, and obviously not a link.
  it("refuses a link whose scheme is not http or https", () => {
    const html = renderMarkdown("[click me](javascript:alert(1))");

    expect(html).not.toContain("href");
    expect(html).toContain("click me");
  });

  // A link is parked behind a placeholder while bare URLs are matched, and put
  // back afterwards. If that placeholder were a bare number, the restore pass
  // would find the digits in "12%" first and paste an anchor into the middle of
  // the prose. Numbers next to links is the ordinary shape of a summary.
  it("leaves numbers in the prose alone while restoring links", () => {
    const html = renderMarkdown("Signups rose 12% — see [the report](https://example.com/r).");

    expect(html).toContain("Signups rose 12%");
    expect(html).toContain('href="https://example.com/r"');
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it("links a bare URL the model left in the prose", () => {
    const html = renderMarkdown("Source: https://example.com/post");

    expect(html).toContain('href="https://example.com/post"');
  });
});
