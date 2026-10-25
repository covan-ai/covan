import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArrivalItem } from "./read";

/**
 * Sorting what arrived into ten kinds, and naming each.
 *
 * The model is stubbed; what is under test is what is sent (batches, numbered
 * lines, no addresses) and that nothing it answers can crash a scan or put an
 * item in a kind that does not exist.
 */
const complete = vi.fn();
vi.mock("../completion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../completion")>()),
  complete: (...args: unknown[]) => complete(...args),
}));

const { CLASSIFY_BATCH, bucketise, classifyItems, headline, labelBuckets } = await import("./classify");

const NOW = new Date("2026-10-26T09:00:00Z");
const ENV = { OPENAI_API_KEY: "sk" } as never;
const USAGE = { promptTokens: 1000, completionTokens: 100, cachedTokens: null };

function mail(i: number, over: Partial<ArrivalItem> = {}): ArrivalItem {
  return {
    id: `t${i}`,
    source: "mail",
    domain: "acme.test",
    subject: `Subject ${i}`,
    snippet: `Snippet ${i}`,
    at: "2026-10-20T08:00:00.000Z",
    fromMe: false,
    repliedByMe: false,
    ...over,
  };
}

function reply(obj: unknown) {
  return { text: typeof obj === "string" ? obj : JSON.stringify(obj), usage: USAGE, finishReason: "stop" };
}

beforeEach(() => complete.mockReset());

describe("classifyItems", () => {
  it("sends mail in batches, numbered from zero in each", async () => {
    complete.mockResolvedValue(reply({ items: [] }));
    const items = Array.from({ length: CLASSIFY_BATCH + 10 }, (_, i) => mail(i));
    await classifyItems(ENV, items);
    expect(complete).toHaveBeenCalledTimes(2);
    const second = complete.mock.calls[1][1];
    expect(second.json).toBe(true);
    const lines = second.messages.at(-1).content.split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe(`0. from: acme.test · Subject ${CLASSIFY_BATCH} · Snippet ${CLASSIFY_BATCH}`);
  });

  it("takes the kind the model gives each line", async () => {
    complete.mockResolvedValue(
      reply({ items: [{ i: 0, kind: "question" }, { i: 1, kind: "admin" }] }),
    );
    const { kinds, spent } = await classifyItems(ENV, [mail(0), mail(1)]);
    expect(kinds).toEqual(["question", "admin"]);
    expect(spent).toEqual([expect.objectContaining({ kind: "completion", purpose: "arrivals" })]);
  });

  it("counts a line the model left out, or put in a kind that does not exist, as other", async () => {
    complete.mockResolvedValue(
      reply({ items: [{ i: 1, kind: "spam" }, { i: 9, kind: "question" }, { i: "0", kind: "question" }] }),
    );
    const { kinds } = await classifyItems(ENV, [mail(0), mail(1), mail(2)]);
    expect(kinds).toEqual(["other", "other", "other"]);
  });

  it("survives a reply that is not JSON, and still pays for it", async () => {
    complete.mockResolvedValue(reply("I could not do that"));
    const { kinds, spent } = await classifyItems(ENV, [mail(0), mail(1)]);
    expect(kinds).toEqual(["other", "other"]);
    expect(spent).toHaveLength(1);
  });

  it("counts calendar events as scheduling without asking the model", async () => {
    const events = [0, 1, 2].map((i) => mail(i, { source: "event", domain: "", snippet: "" }));
    const { kinds, spent } = await classifyItems(ENV, events);
    expect(complete).not.toHaveBeenCalled();
    expect(kinds).toEqual(["scheduling", "scheduling", "scheduling"]);
    expect(spent).toEqual([]);
  });

  it("tells the model which domains are the person's own", async () => {
    complete.mockResolvedValue(reply({ items: [] }));
    await classifyItems(ENV, [mail(0)], { selfDomains: ["covan.test"] });
    expect(complete.mock.calls[0][1].messages[0].content).toContain("covan.test");
  });
});

describe("bucketise", () => {
  it("counts per kind, largest first, leaving out kinds with nothing", () => {
    const items = [mail(0), mail(1), mail(2), mail(3)];
    const buckets = bucketise(items, ["admin", "question", "question", "pitch"], NOW);
    expect(buckets.map((b) => [b.kind, b.count])).toEqual([
      ["question", 2],
      ["admin", 1],
      ["pitch", 1],
    ]);
    expect(buckets.find((b) => b.kind === "question")?.templateId).toBe("arrivals-questions");
    expect(buckets.find((b) => b.kind === "pitch")?.templateId).toBeNull();
  });

  it("counts a reply owed only on questions and requests, older than two days, never answered", () => {
    const items = [
      mail(0), // question, waiting six days
      mail(1, { repliedByMe: true }), // question, answered
      mail(2, { at: "2026-10-25T09:00:00.000Z" }), // question, one day old
      mail(3), // update, nobody waiting
      mail(4), // request, waiting
    ];
    const buckets = bucketise(items, ["question", "question", "question", "update", "request"], NOW);
    const by = Object.fromEntries(buckets.map((b) => [b.kind, b.unanswered]));
    expect(by).toEqual({ question: 1, update: 0, request: 1 });
  });

  it("keeps at most three subjects, the newest", () => {
    const items = [0, 1, 2, 3].map((i) => mail(i, { at: `2026-10-2${i}T08:00:00.000Z` }));
    const [bucket] = bucketise(items, ["admin", "admin", "admin", "admin"], NOW);
    expect(bucket.examples).toEqual(["Subject 3", "Subject 2", "Subject 1"]);
    expect(bucket.label).toBe("");
  });
});

describe("labelBuckets", () => {
  const items = [0, 1, 2, 3, 4].map((i) => mail(i));
  const buckets = bucketise(items, ["admin", "admin", "admin", "pitch", "pitch"], NOW);
  const subjects = new Map([
    ["admin", ["Invoice 1", "Invoice 2", "Receipt 3"]],
    ["pitch", ["Grow your leads", "Quick intro"]],
  ] as const);

  it("names a bucket in one call and picks its examples", async () => {
    complete.mockResolvedValue(
      reply({ buckets: [{ kind: "admin", label: "Supplier invoices", examples: [2, 0] }] }),
    );
    const { buckets: out, spent } = await labelBuckets(ENV, buckets, new Map(subjects));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(out.find((b) => b.kind === "admin")).toMatchObject({
      label: "Supplier invoices",
      examples: ["Receipt 3", "Invoice 1"],
    });
    expect(spent).toHaveLength(1);
  });

  it("leaves a bucket of two with the kind's name and all its subjects", async () => {
    complete.mockResolvedValue(reply({ buckets: [{ kind: "pitch", label: "Should not stick" }] }));
    const { buckets: out } = await labelBuckets(ENV, buckets, new Map(subjects));
    expect(out.find((b) => b.kind === "pitch")).toMatchObject({
      label: "",
      examples: ["Grow your leads", "Quick intro"],
    });
    const sent = complete.mock.calls[0][1].messages.at(-1).content as string;
    expect(sent).not.toContain("Grow your leads");
  });

  it("keeps the counts' own examples when the reply is unusable", async () => {
    complete.mockResolvedValue(reply("{not json"));
    const { buckets: out } = await labelBuckets(ENV, buckets, new Map(subjects));
    expect(out.find((b) => b.kind === "admin")).toMatchObject({ label: "", examples: buckets[0].examples });
  });

  it("makes no call when no bucket is big enough to name", async () => {
    const small = bucketise([mail(0)], ["admin"], NOW);
    const { spent } = await labelBuckets(ENV, small, new Map([["admin", ["Invoice 1"]]]));
    expect(complete).not.toHaveBeenCalled();
    expect(spent).toEqual([]);
  });
});

describe("headline", () => {
  it("adds the buckets up", () => {
    const buckets = bucketise([mail(0), mail(1), mail(2)], ["question", "request", "update"], NOW);
    expect(headline(buckets)).toEqual({ total: 3, unanswered: 2 });
  });
});
