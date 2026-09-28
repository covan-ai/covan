import { describe, it, expect } from "vitest";

import { compactForModel } from "./compact";
import { MAX_TOOL_OUTPUT_CHARS } from "./budget";

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

  it("decodes a payload in the url-safe alphabet, which atob alone refuses", () => {
    // RFC 4648 §5: `+` becomes `-`, `/` becomes `_`, and the padding is dropped.
    // GitHub, Google and anything that puts a payload in a query string encode
    // this way. `atob` throws on both substituted characters, so before #210 the
    // content was left encoded and the model decoded it in output tokens — the
    // one thing this function exists to prevent, paid at the dearest rate.
    const text = "diff --git a/x?y=1 b/x?y=1\n+++ ???>>>";
    const urlSafe = Buffer.from(text, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(urlSafe).toMatch(/[-_]/);

    const out = compactForModel(JSON.stringify({ content: urlSafe, encoding: "base64" }), 12_000);

    expect(out).toContain("diff --git");
    expect(out).toContain("utf-8");
    expect(out).not.toContain(urlSafe);
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

  it("does not round-trip a body it had no reason to touch", () => {
    // JSON.parse/JSON.stringify is not lossless for numbers. An int64 record
    // id comes back off by one, the model sends the wrong id to the next call,
    // and the service updates the neighbouring record.
    const body = '{"id":9007199254740993,"big":12345678901234567890,"amount":1.10,"neg":-0}';
    expect(compactForModel(body, 12_000)).toBe(body);
  });

  it("keeps a string that merely begins with a link", () => {
    // `body` here is the issue description. A prefix match takes the whole
    // field, and the model then reports the issue has none.
    const body = JSON.stringify({
      data: Array.from({ length: 200 }, (_, i) => ({
        number: i,
        body: `https://app.example.com/r/9f2\n\nSteps: 1. open the ${"x".repeat(80)}`,
        url: `https://api.github.com/repos/o/r/issues/${i}`,
      })),
    });
    expect(body.length).toBeGreaterThan(12_000);

    const out = compactForModel(body, 12_000);
    expect(out).toContain("Steps: 1. open the");
    expect(out).not.toContain("api.github.com");
  });

  it("stays inside the budget it was given, notice and all", () => {
    // The notice is the only thing that makes the loss recoverable, and it was
    // appended AFTER the cap — so it was always the part `loop.ts` cut off,
    // and the size it reported was the capped length rather than the real one.
    const tree = Array.from({ length: 4000 }, (_, i) => ({
      path: `src/file${i}.ts`,
      sha: "a".repeat(40),
      url: `https://api.github.com/repos/o/r/git/blobs/${"a".repeat(40)}`,
    }));
    const out = compactForModel(JSON.stringify({ data: { tree } }), 12_000);

    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out).toMatch(/\[urls omitted to fit/);
  });

  it("keeps a field literally called __proto__", () => {
    const out = JSON.parse(compactForModel('{"__proto__":{"a":1},"b":2}', 12_000));
    expect(Object.keys(out).sort()).toEqual(["__proto__", "b"]);
  });
});

/**
 * The literals above are a budget, not THE budget.
 *
 * Every test in this file passes `12_000` by hand because each is about what
 * `compactForModel` does at a given ceiling, and coupling them to the tuning
 * constant would make a behaviour test fail when somebody retunes. The gap that
 * leaves — nothing checking the function honours the ceiling it is actually given
 * in production — is closed here instead, with one test that reads the constant.
 */
describe("at the ceiling production actually gives it", () => {
  it("stays inside the real cap", () => {
    const big = {
      rows: Array.from({ length: 4_000 }, (_, i) => ({ id: i, url: "https://x.example/" + i })),
    };
    const out = compactForModel(JSON.stringify(big), MAX_TOOL_OUTPUT_CHARS);
    expect(out.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
  });
});
