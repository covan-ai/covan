import { describe, it, expect, vi, beforeEach } from "vitest";

// Titling goes through the provider seam, not an SDK: a workspace on a Claude
// model must get its titles from Claude and not need an OpenAI key to have a
// named sidebar.
const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("./completion", async (orig) => ({
  ...(await orig<typeof import("./completion")>()),
  complete,
}));

const { parseTitleSuggestion, buildTitleMessages, generateSessionTitle, TITLE_MAX_CHARS } =
  await import("./session-title");

describe("parseTitleSuggestion", () => {
  it("parses well-formed { title: string } JSON", () => {
    const raw = JSON.stringify({ title: "Q3 pricing review" });
    expect(parseTitleSuggestion(raw)).toBe("Q3 pricing review");
  });

  it("trims surrounding whitespace", () => {
    expect(parseTitleSuggestion(JSON.stringify({ title: "  Onboarding email\n" }))).toBe(
      "Onboarding email",
    );
  });

  it("strips the quotes and trailing period models like to add", () => {
    expect(parseTitleSuggestion(JSON.stringify({ title: '"Onboarding email"' }))).toBe(
      "Onboarding email",
    );
    expect(parseTitleSuggestion(JSON.stringify({ title: "Onboarding email." }))).toBe(
      "Onboarding email",
    );
  });

  it("collapses newlines so a title stays one line in the sidebar", () => {
    expect(parseTitleSuggestion(JSON.stringify({ title: "Onboarding\nemail copy" }))).toBe(
      "Onboarding email copy",
    );
  });

  it("truncates an over-long title to the column the sidebar can show", () => {
    const long = "a".repeat(TITLE_MAX_CHARS + 40);
    const parsed = parseTitleSuggestion(JSON.stringify({ title: long }));
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(TITLE_MAX_CHARS);
  });

  it("returns null for a blank or non-string title", () => {
    expect(parseTitleSuggestion(JSON.stringify({ title: "" }))).toBeNull();
    expect(parseTitleSuggestion(JSON.stringify({ title: "   " }))).toBeNull();
    expect(parseTitleSuggestion(JSON.stringify({ title: 42 }))).toBeNull();
  });

  it("returns null when stripping leaves nothing behind", () => {
    expect(parseTitleSuggestion(JSON.stringify({ title: '"."' }))).toBeNull();
  });

  it("returns null for non-JSON, non-object, or missing title", () => {
    expect(parseTitleSuggestion("not json")).toBeNull();
    expect(parseTitleSuggestion("[]")).toBeNull();
    expect(parseTitleSuggestion(JSON.stringify({}))).toBeNull();
    expect(parseTitleSuggestion("null")).toBeNull();
  });
});

describe("buildTitleMessages", () => {
  it("includes the message and asks for a JSON title", () => {
    const msgs = buildTitleMessages("How should we price the team plan?");
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content.toLowerCase()).toContain("json");
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toContain("How should we price the team plan?");
  });

  it("tells the model to answer in the language of the message", () => {
    // Turkish, deliberately: the title must come back in the asker's own
    // language, and an English fixture could not tell that apart from a
    // prompt that always answers in English.
    const msgs = buildTitleMessages("Takım planını nasıl fiyatlandırmalıyız?");
    expect(msgs[0].content.toLowerCase()).toContain("language");
  });

  it("truncates a giant pasted message rather than paying to title all of it", () => {
    const huge = "x".repeat(5000);
    const msgs = buildTitleMessages(huge);
    expect(msgs[1].content.length).toBeLessThan(1200);
  });
});

const ENV = { OPENAI_API_KEY: "sk-test" };

/** What the seam gives back: a reply, and what it cost. */
const answers = (text: string, promptTokens = 60, completionTokens = 10) =>
  complete.mockResolvedValue({
    text,
    usage: { promptTokens, completionTokens, cachedTokens: null },
  });

describe("generateSessionTitle", () => {
  // A block body, not a concise one: `mockReset()` returns the mock, and a
  // function returned from beforeEach is taken as the teardown callback and
  // called after the test — which would invoke the mock an extra time.
  beforeEach(() => {
    complete.mockReset();
  });

  it("returns the title the model wrote, and what it cost", async () => {
    answers(JSON.stringify({ title: "Team plan pricing" }), 70, 21);

    const result = await generateSessionTitle(ENV, "gpt-4o", "How do we price teams?");

    expect(result).toEqual({ title: "Team plan pricing", tokens: 91 });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][1]).toMatchObject({ model: "gpt-4o", json: true });
  });

  // Naming a conversation is shaping, not thinking. A reasoning model left to
  // deliberate over it spends the whole ceiling on thought and returns nothing
  // — the same thing that had to be said about the persona drafter.
  it("asks a reasoning model not to think about it", async () => {
    answers(JSON.stringify({ title: "Team plan pricing" }));

    await generateSessionTitle(ENV, "gpt-5", "How do we price teams?");

    expect(complete.mock.calls[0][1]).toMatchObject({ reasoningEffort: "minimal" });
  });

  // The reply is already on screen by the time this is awaited, but the
  // composer stays disabled until the turn closes — so a titling call that
  // hangs would hold the user's keyboard hostage. It is given something to be
  // given up on.
  it("hands the call a signal so a hung request cannot hold up the turn", async () => {
    answers(JSON.stringify({ title: "Team plan pricing" }));

    await generateSessionTitle(ENV, "gpt-4o", "How do we price teams?");

    const signal = complete.mock.calls[0][2]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  // The tokens were spent whether or not the reply was usable, so they are
  // still reported: the caller charges them to the same allowance as the turn.
  it("reports the cost of a reply it could not parse, with no title", async () => {
    answers("not json at all", 30, 14);

    await expect(generateSessionTitle(ENV, "gpt-4o", "hi")).resolves.toEqual({
      title: null,
      tokens: 44,
    });
  });

  // A session title is worth nothing next to the reply it rides along with, so
  // a failed call is swallowed here rather than left to abort the turn.
  it("swallows a failed call rather than letting it break the reply", async () => {
    complete.mockImplementation(() => {
      throw new Error("the provider is down");
    });

    await expect(generateSessionTitle(ENV, "gpt-4o", "hi")).resolves.toEqual({
      title: null,
      tokens: 0,
    });
  });
});
