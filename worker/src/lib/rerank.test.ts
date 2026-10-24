import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RetrievedChunk } from "./rag";

let reply: () => Promise<{ text: string; usage: Record<string, number> }>;
const requests: Array<{ model: string; messages: { content: string }[] }> = [];
vi.mock("./completion", () => ({
  complete: async (_env: unknown, req: { model: string; messages: { content: string }[] }) => {
    requests.push(req);
    const r = await reply();
    return { ...r, finishReason: "stop" };
  },
}));

import { parseRerankScores, rerankPassages } from "./rerank";

const passage = (content: string): RetrievedChunk => ({
  documentId: content,
  documentName: `${content}.md`,
  content,
  similarity: 0.4,
});

describe("parseRerankScores", () => {
  it("reads the passages the model named, by number, and scores the rest 0", () => {
    expect(parseRerankScores('{"scores":{"1":3,"3":1}}', 3)).toEqual([3, 0, 1]);
  });

  it("reads an empty object as nothing relevant", () => {
    expect(parseRerankScores('{"scores":{}}', 3)).toEqual([0, 0, 0]);
  });

  it("ignores a number outside the list rather than refusing the whole reply", () => {
    expect(parseRerankScores('{"scores":{"2":3,"9":3}}', 3)).toEqual([0, 3, 0]);
  });

  it("refuses a score outside 0–3 or not a whole number", () => {
    expect(parseRerankScores('{"scores":{"1":4}}', 3)).toBeNull();
    expect(parseRerankScores('{"scores":{"1":1.5}}', 3)).toBeNull();
  });

  it("refuses something that is not JSON, or not the shape asked for", () => {
    expect(parseRerankScores("the first one", 3)).toBeNull();
    expect(parseRerankScores('{"scores":[3,0,1]}', 3)).toBeNull();
  });
});

describe("rerankPassages", () => {
  const passages = ["a", "b", "c", "d"].map(passage);

  beforeEach(() => {
    requests.length = 0;
  });

  it("orders by the model's score, keeping the search's order among equals", async () => {
    reply = async () => ({
      text: '{"scores":{"1":1,"2":3,"3":1,"4":2}}',
      usage: { promptTokens: 100, completionTokens: 10 },
    });
    const r = await rerankPassages({} as never, "gpt-5-nano", "q", passages, 10);
    expect(r.passages.map((p) => p.content)).toEqual(["b", "d", "a", "c"]);
    expect(r.passages.map((p) => p.rerankScore)).toEqual([3, 2, 1, 1]);
    expect(r.reranked).toBe(true);
  });

  it("drops what the model scored as unrelated, and keeps at most `keep`", async () => {
    reply = async () => ({
      text: '{"scores":{"2":3,"3":2,"4":1}}',
      usage: { promptTokens: 100, completionTokens: 10 },
    });
    const r = await rerankPassages({} as never, "gpt-5-nano", "q", passages, 2);
    expect(r.passages.map((p) => p.content)).toEqual(["b", "c"]);
  });

  it("can keep nothing, when nothing bears on the question", async () => {
    reply = async () => ({
      text: '{"scores":{}}',
      usage: { promptTokens: 100, completionTokens: 10 },
    });
    const r = await rerankPassages({} as never, "gpt-5-nano", "q", passages, 10);
    expect(r.passages).toEqual([]);
    expect(r.reranked).toBe(true);
  });

  it("falls back to the search's order when the reply is unusable, and still reports the spend", async () => {
    reply = async () => ({ text: "sorry", usage: { promptTokens: 100, completionTokens: 10 } });
    const r = await rerankPassages({} as never, "gpt-5-nano", "q", passages, 3);
    expect(r.passages.map((p) => p.content)).toEqual(["a", "b", "c"]);
    expect(r.reranked).toBe(false);
    expect(r.spend).not.toBeNull();
  });

  it("falls back to the search's order when the call fails", async () => {
    reply = async () => {
      throw new Error("timeout");
    };
    const r = await rerankPassages({} as never, "gpt-5-nano", "q", passages, 3);
    expect(r.passages.map((p) => p.content)).toEqual(["a", "b", "c"]);
    expect(r.reranked).toBe(false);
    expect(r.spend).toBeNull();
  });

  it("makes no call for an empty list", async () => {
    const r = await rerankPassages({} as never, "gpt-5-nano", "q", [], 10);
    expect(r.passages).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("sends each passage numbered, with its document name, and the question", async () => {
    reply = async () => ({ text: '{"scores":{"1":1}}', usage: { promptTokens: 1 } });
    await rerankPassages({} as never, "gpt-5-nano", "fesih süresi", passages, 10);
    const sent = requests[0].messages.map((m) => m.content).join("\n");
    expect(sent).toContain("fesih süresi");
    expect(sent).toContain("[3] c.md");
  });
});
