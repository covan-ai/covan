import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb } from "../test-support/fake-db";
import { documents } from "./documents";

/** `GET /documents/:id/export/:format`: Markdown out as Word, or as PDF where there is a printer. */

const storeGet = vi.fn();
const render = vi.fn();
let printer: { render: typeof render } | null = null;

vi.mock("../lib/docstore", () => ({ getDocStore: () => ({ get: storeGet }) }));
vi.mock("../lib/formats/pdf", () => ({ pdfRenderer: () => printer }));

function appWith(row: Record<string, unknown> | null) {
  const fake = fakeDb({
    tables: { documents: { select: () => ({ data: row, error: null }) } },
  });
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: "user-1" } as never);
    c.set("db", fake.db as never);
    await next();
  });
  app.route("/", documents);
  return app;
}

const REPORT = { name: "Çeyrek raporu.md", r2_key: "bundle-1/abc-Ceyrek.md" };

beforeEach(() => {
  vi.clearAllMocks();
  printer = null;
  storeGet.mockResolvedValue({
    arrayBuffer: async () => new TextEncoder().encode("# Çeyrek raporu\n\nGelir arttı.").buffer,
  });
});

describe("GET /documents/:id/export/:format", () => {
  it("answers a Word file named after the document", async () => {
    const res = await appWith(REPORT).request("/documents/doc-1/export/docx");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("wordprocessingml");
    expect(res.headers.get("Content-Disposition")).toContain(
      encodeURIComponent("Çeyrek raporu.docx"),
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
  });

  it("prints a PDF where the deployment has a browser", async () => {
    printer = { render };
    render.mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    const res = await appWith(REPORT).request("/documents/doc-1/export/pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(render).toHaveBeenCalledWith("# Çeyrek raporu\n\nGelir arttı.");
  });

  it("tells the page to print it itself where there is no browser", async () => {
    const res = await appWith(REPORT).request("/documents/doc-1/export/pdf");
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ fallback: "print" });
    expect(storeGet).not.toHaveBeenCalled();
  });

  it("converts only Markdown", async () => {
    const res = await appWith({ name: "deck.pdf", r2_key: "k" }).request(
      "/documents/doc-1/export/docx",
    );
    expect(res.status).toBe(415);
  });

  it("answers a document the caller cannot see as not found", async () => {
    const res = await appWith(null).request("/documents/doc-1/export/docx");
    expect(res.status).toBe(404);
  });

  it("knows only two formats", async () => {
    const res = await appWith(REPORT).request("/documents/doc-1/export/rtf");
    expect(res.status).toBe(400);
  });
});
