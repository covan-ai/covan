import { describe, it, expect, vi } from "vitest";
import { parseDraft, draftSchema } from "./draft";

const llm = (payload: unknown) => vi.fn(async () => JSON.stringify(payload));

describe("parseDraft", () => {
  it("turns a natural-language request into a structured draft", async () => {
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
      ownHosts: ["api.example.com"],
    });

    expect(draft).toEqual({
      name: "r/saas new posts",
      sourceKind: "rss",
      sourceUrl: "https://www.reddit.com/r/saas/new/.rss",
      cron: "*/15 * * * *",
      timezone: "Europe/Istanbul",
      instruction: "Summarise every post in 2 sentences.",
      channelKind: "slack",
    });
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
    await expect(parseDraft("x", { complete, timezone: "UTC", ownHosts: [] })).rejects.toThrow(
      /cron/i,
    );
  });

  it("rejects a source url that fails the SSRF guard", async () => {
    const complete = llm({
      name: "x",
      sourceKind: "web",
      sourceUrl: "http://169.254.169.254/latest",
      cron: "0 9 * * *",
      instruction: "x",
      channelKind: "email",
    });
    await expect(parseDraft("x", { complete, timezone: "UTC", ownHosts: [] })).rejects.toThrow(
      /unsafe url/,
    );
  });

  it("requires a url for source kinds that watch something", async () => {
    const complete = llm({
      name: "x",
      sourceKind: "rss",
      sourceUrl: null,
      cron: "0 9 * * *",
      instruction: "x",
      channelKind: "email",
    });
    await expect(parseDraft("x", { complete, timezone: "UTC", ownHosts: [] })).rejects.toThrow(
      /url/i,
    );
  });

  it("rejects an LLM response that is not valid draft JSON", async () => {
    await expect(
      parseDraft("x", { complete: vi.fn(async () => "sorry!"), timezone: "UTC", ownHosts: [] }),
    ).rejects.toThrow();
  });
});

describe("draftSchema", () => {
  it("only accepts the source kinds the engine implements", () => {
    expect(draftSchema.shape.sourceKind.safeParse("twitter").success).toBe(false);
    expect(draftSchema.shape.sourceKind.safeParse("rss").success).toBe(true);
  });
});
