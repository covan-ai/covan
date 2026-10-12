import { describe, it, expect, vi } from "vitest";
import { parseDraft, draftSchema } from "./draft";

const llm = (payload: unknown) => vi.fn(async () => JSON.stringify(payload));

describe("parseDraft", () => {
  it("turns a natural-language request into a structured draft", async () => {
    const complete = llm({
      name: "Morning bug summary",
      sourceKind: "none",
      sourceUrl: null,
      cron: "0 9 * * *",
      instruction: "Summarise the open high-priority bugs.",
      channelKind: "slack",
    });

    const draft = await parseDraft("summarise open bugs to Slack every morning at 9", {
      complete,
      timezone: "Europe/Istanbul",
    });

    expect(draft).toEqual({
      name: "Morning bug summary",
      sourceKind: "none",
      sourceUrl: null,
      cron: "0 9 * * *",
      timezone: "Europe/Istanbul",
      instruction: "Summarise the open high-priority bugs.",
      channelKind: "slack",
    });
  });

  it("folds a feed the model proposed anyway into a scheduled task, keeping the URL", async () => {
    // The dialog has no field for a feed or a page (covan#241), so a draft that
    // named one would land on a form that cannot show what it was about to watch.
    const complete = llm({
      name: "r/saas new posts",
      sourceKind: "rss",
      sourceUrl: "https://www.reddit.com/r/saas/new/.rss",
      cron: "*/15 * * * *",
      instruction: "Summarise every post in 2 sentences.",
      channelKind: "slack",
    });

    const draft = await parseDraft("watch r/saas and send a summary to Slack on every new post", {
      complete,
      timezone: "Europe/Istanbul",
    });

    expect(draft.sourceKind).toBe("none");
    expect(draft.sourceUrl).toBeNull();
    expect(draft.instruction).toBe(
      "Summarise every post in 2 sentences.\n\nSource: https://www.reddit.com/r/saas/new/.rss",
    );
  });

  it("folds a page with no URL into a scheduled task without inventing a source line", async () => {
    const complete = llm({
      name: "x",
      sourceKind: "web",
      sourceUrl: null,
      cron: "0 9 * * *",
      instruction: "Check the page.",
      channelKind: "email",
    });

    const draft = await parseDraft("x", { complete, timezone: "UTC" });

    expect(draft.sourceKind).toBe("none");
    expect(draft.instruction).toBe("Check the page.");
  });

  it("rejects a draft whose cron the engine cannot parse", async () => {
    const complete = llm({
      name: "x",
      sourceKind: "none",
      sourceUrl: null,
      cron: "every so often",
      instruction: "x",
      channelKind: "email",
    });
    await expect(parseDraft("x", { complete, timezone: "UTC" })).rejects.toThrow(/cron/i);
  });

  it("rejects an LLM response that is not valid draft JSON", async () => {
    await expect(
      parseDraft("x", { complete: vi.fn(async () => "sorry!"), timezone: "UTC" }),
    ).rejects.toThrow();
  });
});

describe("draftSchema", () => {
  it("only accepts the source kinds the engine implements", () => {
    expect(draftSchema.shape.sourceKind.safeParse("twitter").success).toBe(false);
    expect(draftSchema.shape.sourceKind.safeParse("rss").success).toBe(true);
  });
});
