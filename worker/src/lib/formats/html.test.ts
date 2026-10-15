import { describe, expect, it } from "vitest";
import { fontOriginFrom, markdownToPrintHtml } from "./html";

describe("markdownToPrintHtml", () => {
  it("renders the document and titles the page after it", () => {
    const html = markdownToPrintHtml("# Q3 review\n\nRevenue was **up**.", null);
    expect(html).toContain("<title>Q3 review</title>");
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>up</strong>");
  });

  it("shows raw HTML as text, never as markup", () => {
    const html = markdownToPrintHtml('Hi <script>fetch("x")</script><img src=x onerror=1>', null);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("keeps only links somebody could safely click", () => {
    const html = markdownToPrintHtml("[a](https://example.com) [b](javascript:alert(1))", null);
    expect(html).toContain('<a href="https://example.com/">a</a>');
    expect(html).not.toContain("javascript:");
  });

  it("turns an image into its alt text, so nothing is fetched", () => {
    const html = markdownToPrintHtml("![a chart](https://evil.example/x.png)", null);
    expect(html).not.toContain("evil.example");
    expect(html).toContain("a chart");
  });

  it("loads the fonts from the app's own origin, and only when it has one", () => {
    expect(markdownToPrintHtml("x", "https://covan.app")).toContain(
      'url("https://covan.app/fonts/geist-400-600-latin-ext.woff2")',
    );
    expect(markdownToPrintHtml("x", null)).not.toContain("@font-face");
  });
});

describe("fontOriginFrom", () => {
  it("takes the first allowed origin", () => {
    expect(fontOriginFrom("https://covan.app, https://preview.covan.app")).toBe(
      "https://covan.app",
    );
  });

  it("refuses anything that is not an https origin", () => {
    expect(fontOriginFrom("http://covan.app")).toBeNull();
    expect(fontOriginFrom("")).toBeNull();
    expect(fontOriginFrom(undefined)).toBeNull();
    expect(fontOriginFrom("http://localhost:5173")).toBe("http://localhost:5173");
  });
});
