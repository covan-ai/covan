import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { DOC_SLUGS, DOCS_HOME, docsUrl } from "./docs";

// The rendered pages live on the marketing site, in a different repository, so
// nothing here can prove a URL resolves. What it can prove is the half this
// repository owns: every slug the interface links to is a markdown file that
// actually exists in `docs/`, which is where the site gets its pages from.
// Deleting or renaming one without touching this list is the way these links
// would rot, and it is the way that stops being silent.
const DOCS_DIR = `${process.cwd()}/docs/`;

describe("documentation links", () => {
  it("points only at pages that exist", () => {
    const missing = DOC_SLUGS.filter((slug) => !existsSync(`${DOCS_DIR}${slug}.md`));
    expect(missing).toEqual([]);
  });

  it("builds one URL per page under the docs index", () => {
    expect(docsUrl("knowledge")).toBe("https://covan.app/docs/knowledge");
    expect(docsUrl("self-hosting")).toBe("https://covan.app/docs/self-hosting");
    expect(DOCS_HOME).toBe("https://covan.app/docs");
  });

  it("has no duplicate slugs", () => {
    expect(new Set(DOC_SLUGS).size).toBe(DOC_SLUGS.length);
  });
});
