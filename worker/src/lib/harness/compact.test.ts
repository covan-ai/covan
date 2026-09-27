import { describe, it, expect } from "vitest";

import { compactForModel } from "./compact";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("compactForModel", () => {
  it("hands back a body under the cap byte for byte", () => {
    const body = JSON.stringify({ data: { items: [{ id: 1, url: "https://x/y" }] } });
    expect(compactForModel(body, 12_000)).toBe(body);
  });

  it("decodes a base64 text payload in place", () => {
    // GitHub's content/README/blob shape. Left encoded, the model spends
    // output tokens decoding it by hand — 4,625 completion tokens on one pass
    // of message f5d874c6, which said "let me decode it fully".
    const body = JSON.stringify({
      data: {
        name: "README.md",
        content: b64("# Covan\n\nA shared AI agent."),
        encoding: "base64",
      },
    });
    const out = JSON.parse(compactForModel(body, 12_000));
    expect(out.data.content).toBe("# Covan\n\nA shared AI agent.");
    expect(out.data.encoding).toBe("utf-8");
  });

  it("leaves a base64 payload that is not text as a size note", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 1, 2, 3]).toString("base64");
    const out = JSON.parse(
      compactForModel(JSON.stringify({ content: png, encoding: "base64" }), 12_000),
    );
    expect(out.content).toBe("[binary, 11 bytes]");
  });

  it("drops url-valued strings first when the body is over the cap, and says so", () => {
    const tree = Array.from({ length: 300 }, (_, i) => ({
      path: `src/file${i}.ts`,
      mode: "100644",
      type: "blob",
      sha: "a".repeat(40),
      url: `https://api.github.com/repos/o/r/git/blobs/${"a".repeat(40)}`,
    }));
    const body = JSON.stringify({ data: { sha: "b".repeat(40), tree } });
    expect(body.length).toBeGreaterThan(12_000);

    const out = compactForModel(body, 12_000);
    expect(out).not.toContain("api.github.com");
    // What the model actually needs off a tree listing survives.
    expect(out).toContain('"sha":"aaaa');
    expect(out).toMatch(/\[urls omitted to fit/);
  });

  it("only caps a body that is not JSON", () => {
    const text = "x".repeat(13_000);
    expect(compactForModel(text, 12_000)).toMatch(
      /\[trimmed: 13000 characters, showing the first 12000\]$/,
    );
  });

  it("does not decode a decoded file that happens to mention base64 encoding", () => {
    // A README describing this very shape would otherwise be parsed as JSON
    // and walked a second time. A decoded string is never re-read.
    const inner = JSON.stringify({ content: b64("nested"), encoding: "base64" });
    const body = JSON.stringify({ content: b64(inner), encoding: "base64" });
    const out = JSON.parse(compactForModel(body, 12_000));
    expect(out.content).toBe(inner);
    expect(out.encoding).toBe("utf-8");
  });
});
