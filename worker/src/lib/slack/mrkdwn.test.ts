import { describe, it, expect } from "vitest";
import { toMrkdwn } from "./mrkdwn";

describe("markdown as Slack reads it", () => {
  it("writes bold the way mrkdwn spells it", () => {
    // The defect, at its smallest. This arrived in Slack as four visible
    // asterisks around a word.
    expect(toMrkdwn("**Deadline** is Friday")).toBe("*Deadline* is Friday");
    expect(toMrkdwn("__Deadline__ is Friday")).toBe("*Deadline* is Friday");
  });

  it("writes italic the way mrkdwn spells it, without eating bold", () => {
    expect(toMrkdwn("*maybe* Friday")).toBe("_maybe_ Friday");
    expect(toMrkdwn("**definitely** and *maybe*")).toBe("*definitely* and _maybe_");
  });

  it("leaves an underscore inside a word alone", () => {
    // mrkdwn italicises on `_`, so a rule that rewrote these would turn half an
    // identifier into emphasis. Markdown does not italicise them either.
    expect(toMrkdwn("call some_var_name first")).toBe("call some_var_name first");
  });

  it("turns a link into one somebody can click", () => {
    expect(toMrkdwn("See [the policy](https://example.com/p) first")).toBe(
      "See <https://example.com/p|the policy> first",
    );
  });

  it("does not let emphasis rules loose on a URL", () => {
    // The reason links are cut out before anything else runs: every one of
    // these characters is meaningful to a rule below.
    expect(toMrkdwn("[docs](https://example.com/a_b_c)")).toBe("<https://example.com/a_b_c|docs>");
    expect(toMrkdwn("[x](https://example.com/*star*)")).toBe("<https://example.com/*star*|x>");
  });

  it("unwraps an autolink rather than escaping it into text", () => {
    expect(toMrkdwn("<https://example.com/pricing>")).toBe("https://example.com/pricing");
  });

  it("escapes what Slack would otherwise read as markup", () => {
    expect(toMrkdwn("a < b && c")).toBe("a &lt; b &amp;&amp; c");
  });

  it("keeps a blockquote a blockquote", () => {
    // `>` is the one of the three that is not escaped, because at the start of
    // a line it means the same thing in both languages.
    expect(toMrkdwn("> quoted")).toBe("> quoted");
  });

  it("makes a heading read like one, since mrkdwn has none", () => {
    expect(toMrkdwn("## Leave policy\nTwenty days.")).toBe("*Leave policy*\nTwenty days.");
  });

  it("gives a list bullets, since mrkdwn has no lists either", () => {
    expect(toMrkdwn("- one\n- two\n  - nested")).toBe("• one\n• two\n  • nested");
  });

  it("bullets a list item that is only a link", () => {
    expect(toMrkdwn("- [the policy](https://example.com/p)")).toBe(
      "• <https://example.com/p|the policy>",
    );
  });

  it("writes strikethrough with one tilde", () => {
    expect(toMrkdwn("~~withdrawn~~")).toBe("~withdrawn~");
  });

  it("leaves a code fence exactly as the model wrote it", () => {
    const answer = "Run this:\n\n```sql\nselect * from users where a_b = 1\n```\n\nThen **stop**.";
    expect(toMrkdwn(answer)).toBe(
      "Run this:\n\n```sql\nselect * from users where a_b = 1\n```\n\nThen *stop*.",
    );
  });

  it("leaves an inline code span alone", () => {
    expect(toMrkdwn("set `**not bold**` in the file")).toBe("set `**not bold**` in the file");
  });

  it("treats an unclosed fence as code rather than half-converting it", () => {
    // A model that runs out of room leaves one open. Bullet-pointing the
    // remains of a code sample is the failure that reads as deliberate.
    const answer = "Try:\n\n```\n- not a bullet\n**not bold**";
    expect(toMrkdwn(answer)).toBe("Try:\n\n```\n- not a bullet\n**not bold**");
  });

  it("leaves an ordinary sentence untouched", () => {
    expect(toMrkdwn("Twenty days a year, and you ask in advance.")).toBe(
      "Twenty days a year, and you ask in advance.",
    );
  });
});
