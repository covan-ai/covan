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

const b64url = (s: string) =>
  Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/**
 * One message as `GMAIL_FETCH_EMAILS` returns it: the text Composio extracted,
 * then the Gmail API payload under it with every transport header and the
 * same body twice, once as plain text and once as HTML, both in base64url.
 */
function gmailMessage(i: number, text = `Toplantı notları ${i}. ${"Ayrıntı ".repeat(150)}`) {
  const transport = Array.from({ length: 12 }, (_, h) => ({
    name: h % 2 ? "Received" : "ARC-Message-Signature",
    value: `from mail-${h}.google.com (mail-${h}.google.com. [209.85.0.${h}]) ${"k".repeat(400)}`,
  }));
  return {
    messageId: `19f9${String(i).padStart(12, "0")}`,
    threadId: `19f9${String(i).padStart(12, "0")}`,
    subject: `Konu ${i}`,
    sender: `kisi${i}@example.com`,
    messageText: text,
    attachmentList: [
      { filename: "teklif.pdf", attachmentId: `ANGjdJ${i}`, mimeType: "application/pdf" },
    ],
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        ...transport,
        { name: "From", value: `Kişi ${i} <kisi${i}@example.com>` },
        { name: "Subject", value: `Konu ${i}` },
        { name: "Date", value: "Wed, 1 Oct 2026 09:00:00 +0300" },
        { name: "DKIM-Signature", value: "v=1; a=rsa-sha256; " + "b".repeat(600) },
      ],
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { size: text.length, data: b64url(text) } },
            {
              mimeType: "text/html",
              body: { size: 9_000, data: b64url(`<div dir="ltr"><p>${text}</p></div>`.repeat(3)) },
            },
          ],
        },
        {
          mimeType: "application/pdf",
          filename: "teklif.pdf",
          body: { size: 3, attachmentId: `ANGjdJ${i}`, data: b64url("%PDF\u0000\u0001") },
        },
      ],
    },
  };
}

describe("mail", () => {
  it("keeps the headers a person reads and drops the transport", () => {
    const out = compactForModel(JSON.stringify({ data: { messages: [gmailMessage(1)] } }), 12_000);
    expect(out).not.toMatch(/Received|ARC-Message-Signature|DKIM-Signature/);
    const headers = JSON.parse(out).data.messages[0].payload.headers;
    expect(headers.map((h: { name: string }) => h.name)).toEqual(["From", "Subject", "Date"]);
  });

  it("decodes the plain part, drops its HTML twin and sizes the attachment", () => {
    const out = JSON.parse(
      compactForModel(JSON.stringify({ data: { messages: [gmailMessage(1)] } }), 12_000),
    );
    const [alternative, pdf] = out.data.messages[0].payload.parts;
    expect(alternative.parts).toHaveLength(1);
    expect(alternative.parts[0].body.data).toMatch(/^Toplantı notları 1\./);
    expect(pdf.body.data).toMatch(/^\[binary, \d+ bytes\]$/);
    // What fetching the attachment needs is still there.
    expect(pdf.body.attachmentId).toBe("ANGjdJ1");
  });

  it("reads an HTML part as text when it is the only one", () => {
    const html = `<html><body><table><tr><td><p>Fatura ektedir.</p></td></tr></table></body></html>`;
    const body = JSON.stringify({
      payload: { mimeType: "text/html", body: { size: html.length, data: b64url(html) } },
    });
    const out = JSON.parse(compactForModel(body, 12_000));
    expect(out.payload.body.data).toContain("Fatura ektedir.");
    expect(out.payload.body.data).not.toContain("<td>");
  });

  it("leaves a body that arrived already decoded as it was", () => {
    const body = JSON.stringify({
      payload: { mimeType: "text/plain", body: { size: 9, data: "Hello Ada" } },
      headers: [{ name: "Received", value: "from x" }],
    });
    expect(JSON.parse(compactForModel(body, 12_000)).payload.body.data).toBe("Hello Ada");
  });

  it("leaves a list of name/value settings that is not mail alone", () => {
    const body = JSON.stringify({ settings: [{ name: "theme", value: "dark" }] });
    expect(compactForModel(body, 12_000)).toBe(body);
  });

  it("fits thirty messages that came back as their transport headers", () => {
    // `verbose: false`, the shape of 2026-10-01: thirty messages asked for, the
    // header list of one returned, and the turn spent eleven Gmail calls and
    // 300,000 prompt tokens re-asking for what the cap had cut.
    const messages = Array.from({ length: 30 }, (_, i) => {
      const { messageId, threadId, payload } = gmailMessage(i);
      return { messageId, threadId, labelIds: ["INBOX"], payload: { headers: payload.headers } };
    });
    const body = JSON.stringify({ data: { messages, resultSizeEstimate: 30 } });
    expect(body.length).toBeGreaterThan(150_000);

    const out = compactForModel(body, 12_000);

    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out).not.toMatch(/\[trimmed|\[long text/);
    for (let i = 0; i < 30; i += 1) expect(out).toContain(`"value":"Konu ${i}"`);
  });

  it("shows every message of a long list, each cut short, rather than the first one whole", () => {
    // `verbose: true`: no payload, but each message's whole body as HTML.
    const messages = Array.from({ length: 20 }, (_, i) => ({
      messageId: `19f9${String(i).padStart(12, "0")}`,
      subject: `Konu ${i}`,
      sender: `kisi${i}@example.com`,
      messageText: `<table><tr><td><div><p>Merhaba ${i},</p>${"<p>Ayrıntı</p>".repeat(300)}</div></td></tr></table>`,
      attachmentList: [],
    }));
    const body = JSON.stringify({ data: { messages, nextPageToken: "abc" } });
    expect(body.length).toBeGreaterThan(80_000);

    const out = compactForModel(body, 12_000);

    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out).not.toContain("<p>");
    for (let i = 0; i < 20; i += 1) {
      expect(out).toContain(`"subject":"Konu ${i}"`);
      expect(out).toContain(`Merhaba ${i},`);
    }
    expect(out).toMatch(/\[long text shortened to fit/);
    expect(out).not.toMatch(/\[urls omitted|\[trimmed/);
  });

  it("leaves out a blob with no spaces rather than let it hold the whole list over", () => {
    // 2026-10-20, the first pilot mailbox read after #365: two list calls came
    // back cut blind at 12,054 characters. Shortening exempted every string
    // with no space in it, as an id; one mail carrying an inline image or a
    // page-long encoded link was then a string nothing could shorten.
    const blob = "data:image/png;base64," + "iVBORw0KGgo".repeat(3000);
    const messages = Array.from({ length: 15 }, (_, i) => ({
      messageId: `19f9${i}`,
      subject: `Konu ${i}`,
      messageText:
        i === 3
          ? `Ekte resim var ${blob}`.replace(" " + blob, blob)
          : `Merhaba ${i}, ${"bilgi ".repeat(300)}`,
      inline: i === 3 ? blob : undefined,
    }));
    const out = compactForModel(JSON.stringify({ data: { messages } }), 12_000);

    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out).not.toMatch(/\[trimmed/);
    for (let i = 0; i < 15; i += 1) expect(out).toContain(`"subject":"Konu ${i}"`);
    expect(out).toMatch(/characters with no spaces, left out/);
  });

  it("stops between two items, and says how many it showed, when even short ones do not fit", () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({
      id: `r${i}`,
      title: `Kayıt ${i} ${"başlık ".repeat(40)}`,
      body: `Ayrıntı ${"metin ".repeat(60)}`,
      note: `Not ${"kısa ".repeat(40)}`,
    }));
    const out = compactForModel(JSON.stringify({ data: { rows, next_cursor: "c2" } }), 12_000);

    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out).not.toMatch(/\[trimmed/);
    expect(out).toMatch(/\[showing the first \d+ of 400 items/);
    expect(out).toContain('"id":"r0"');
    expect(out).toContain('"next_cursor":"c2"');
  });

  it("never shortens a page token or an id to make a list fit", () => {
    const token = "CiAKGjBpNDd2Nmp2Zml2cXRkMjBhcHNqYXJ0YmQyGgYI" + "Q".repeat(300);
    const messages = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`,
      snippet: `Merhaba ${i}, ${"uzun bir mesaj ".repeat(60)}`,
    }));
    const out = compactForModel(JSON.stringify({ messages, nextPageToken: token }), 12_000);
    expect(out).toContain(`"nextPageToken":"${token}"`);
    expect(out).toMatch(/\[long text shortened to fit/);
  });

  it("reads an HTML email as text, and leaves an HTML file somebody opened as it is", () => {
    const page = `<!DOCTYPE html><html><body>${"<div><p>Merhaba</p></div>".repeat(40)}</body></html>`;
    const mail = JSON.parse(compactForModel(JSON.stringify({ messageText: page }), 12_000));
    expect(mail.messageText).toContain("Merhaba");
    expect(mail.messageText).not.toContain("<div>");

    const file = JSON.parse(
      compactForModel(
        JSON.stringify({ name: "index.html", content: b64(page), encoding: "base64" }),
        12_000,
      ),
    );
    expect(file.content).toBe(page);
  });

  it("leaves a field that merely mentions a tag as it was written", () => {
    const body = JSON.stringify({ title: "Fix the <div> that overflows", body: "x".repeat(400) });
    expect(compactForModel(body, 12_000)).toBe(body);
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
