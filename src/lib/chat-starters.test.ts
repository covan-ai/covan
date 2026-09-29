import { describe, it, expect } from "vitest";
import type { ConnectedApp } from "./connected-apps";
import { startersFor, appStartersFor, GENERAL_STARTERS, CURATED_APP_SLUGS } from "./chat-starters";

describe("startersFor", () => {
  it("falls back to the general prompts for an agent with no knowledge", () => {
    expect(startersFor([])).toEqual([...GENERAL_STARTERS]);
  });

  it("ignores a document that is still being indexed", () => {
    // Naming it would offer a question whose answer cannot cite it yet, which
    // is a worse first impression than not offering it at all.
    expect(startersFor([{ name: "handbook.md", indexed: false }])).toEqual([...GENERAL_STARTERS]);
  });

  it("names a real file once there is one to cite", () => {
    const starters = startersFor([{ name: "handbook.md", indexed: true }]);
    expect(starters[0]).toBe("What does handbook.md say?");
  });

  it("names the first indexed file, not the first file", () => {
    const starters = startersFor([
      { name: "still-uploading.pdf", indexed: false },
      { name: "handbook.md", indexed: true },
    ]);
    expect(starters[0]).toBe("What does handbook.md say?");
  });

  it("asks across the set when there is more than one document", () => {
    const starters = startersFor([
      { name: "handbook.md", indexed: true },
      { name: "contract.pdf", indexed: true },
    ]);
    expect(starters).toContain("What do these documents have in common?");
    expect(starters).not.toContain("Summarize what you know");
  });

  it("always offers exactly four", () => {
    // The empty state lays them out in a two-column grid; a fifth would leave
    // a widowed cell and a third would leave a hole.
    expect(startersFor([])).toHaveLength(4);
    expect(startersFor([{ name: "a.md", indexed: true }])).toHaveLength(4);
    expect(
      startersFor([
        { name: "a.md", indexed: true },
        { name: "b.md", indexed: true },
      ]),
    ).toHaveLength(4);
  });
});

describe("appStartersFor", () => {
  const app = (over: Partial<ConnectedApp> & { slug: string }): ConnectedApp => ({
    name: over.slug,
    logoPath: "",
    provider: null,
    ...over,
  });

  it("offers nothing for a workspace with no connected apps", () => {
    // The caller draws a heading above these. An empty list is how it knows
    // not to draw a labelled region with nothing under it.
    expect(appStartersFor([])).toEqual([]);
  });

  it("offers one line per app, keeping the order it was given", () => {
    // `mergeConnectedApps` already sorted by slug. Re-sorting here would put
    // the decision in two places and let them disagree.
    const out = appStartersFor([
      app({ slug: "slack", name: "Slack" }),
      app({ slug: "gmail", name: "Gmail" }),
    ]);
    expect(out.map((o) => o.app.slug)).toEqual(["slack", "gmail"]);
  });

  it("uses the sentence we wrote for an app we know", () => {
    const [first] = appStartersFor([app({ slug: "linear", name: "Linear" })]);
    expect(first.starter).toBe("What's assigned to me in Linear?");
  });

  it("asks what an unknown app can do rather than telling it to do something", () => {
    // The fallback covers fifteen hundred toolkits whose operations we have
    // not seen. "Search X for the Q3 review" claims a capability the grant may
    // not carry; a question about the app cannot be wrong.
    const [first] = appStartersFor([app({ slug: "acme_crm", name: "Acme CRM" })]);
    expect(first.starter).toBe("What can you do with Acme CRM?");
  });

  it("names the app in the fallback, so a row is never ambiguous", () => {
    const [first] = appStartersFor([app({ slug: "obscure", name: "Obscure Tool" })]);
    expect(first.starter).toContain("Obscure Tool");
  });

  it("phrases every written sentence as a question", () => {
    // Failure mode #1 is a claim the code cannot back, and on this screen the
    // difference is grammatical: an imperative promises an operation, a
    // question asks for one. If the grant cannot do it the answer says so,
    // instead of the interface having lied first.
    const every = appStartersFor(CURATED_APP_SLUGS.map((slug) => app({ slug })));
    for (const { app: a, starter } of every) {
      expect(starter, `${a.slug} is phrased as a question`).toMatch(/\?$/);
    }
  });

  it("looks its table up by slug, not by anything else on the row", () => {
    // Keying off `name` instead would pass every test above — "Linear" and
    // "linear" both reach the right sentence in a one-app fixture — and send
    // every real row, where the name is the product's and the key is the
    // slug's, to the generic question instead.
    for (const slug of CURATED_APP_SLUGS) {
      const [first] = appStartersFor([app({ slug, name: "Placeholder" })]);
      expect(first.starter, `${slug} has its own sentence`).not.toContain("Placeholder");
    }
  });
});
