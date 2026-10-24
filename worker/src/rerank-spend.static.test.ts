import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every place that charges for retrieval charges for its reranker too.
 *
 * A reranker (`lib/rerank.ts`, on when `RAG_RERANK_MODEL` is set) is a model
 * call inside retrieval, reported as `Retrieval.rerankSpend`. Retrieval's
 * other cost — embedding the question — is recorded by each caller as
 * `embeddingSpend(..., "retrieval")`, in six places across chat, Slack, the
 * agent's search tool, routines, reports and the document writer. A seventh
 * that recorded the embedding and forgot the reranker would hand out model
 * calls for nothing, and nothing else would notice. So a file that records one
 * must mention the other.
 */
const src = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

describe("reranker spend", () => {
  const charging = sourceFiles(src).filter((path) =>
    /embeddingSpend\([\s\S]{0,200}?"retrieval"/.test(readFileSync(path, "utf8")),
  );

  it("finds the places that charge for retrieval", () => {
    expect(charging.length).toBeGreaterThanOrEqual(6);
  });

  it("is recorded wherever retrieval's embedding is", () => {
    for (const path of charging) {
      expect(readFileSync(path, "utf8"), relative(src, path)).toContain("rerankSpend");
    }
  });
});
