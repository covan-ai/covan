import { describe, it, expect } from "vitest";
import {
  buildSystemPrefix,
  temperatureFor,
  reasoningEffortFor,
  maxTokensFor,
  BRAINSTORM_INSTRUCTIONS,
  CONCISION_INSTRUCTIONS,
  DEFAULT_PERSONA,
  MANIFEST_NAME_LIMIT,
  REPORT_INSTRUCTIONS,
} from "./prompt";

describe("buildSystemPrefix", () => {
  it("uses the default persona when none is given", () => {
    const out = buildSystemPrefix({ persona: null, mode: "normal", docNames: [] });
    expect(out).toContain(DEFAULT_PERSONA);
  });

  it("does not add brainstorm instructions in normal mode", () => {
    const out = buildSystemPrefix({ persona: "You are our PM.", mode: "normal", docNames: [] });
    expect(out).toContain("You are our PM.");
    expect(out).not.toContain(BRAINSTORM_INSTRUCTIONS);
  });

  it("layers brainstorm instructions on top of the persona in brainstorm mode", () => {
    const out = buildSystemPrefix({ persona: "You are our PM.", mode: "brainstorm", docNames: [] });
    const personaAt = out.indexOf("You are our PM.");
    const brainstormAt = out.indexOf(BRAINSTORM_INSTRUCTIONS);
    expect(personaAt).toBeGreaterThanOrEqual(0);
    expect(brainstormAt).toBeGreaterThan(personaAt); // persona first, then layer
  });

  it("appends a document manifest when docNames are present", () => {
    const out = buildSystemPrefix({ persona: "P", mode: "normal", docNames: ["a.md", "b.md"] });
    expect(out).toContain("a.md, b.md");
    expect(out).toContain("never claim you cannot read files");
  });

  it("tells the agent excerpts only arrive when retrieval finds them", () => {
    // The prefix is byte-identical on every turn, including the ones where
    // nothing was retrieved and no excerpt block follows. Promising the
    // contents "below" on those turns named a file, attached nothing, and left
    // the model to fill the gap.
    const out = buildSystemPrefix({ persona: "P", mode: "normal", docNames: ["a.md"] });
    expect(out).toContain("whenever retrieval finds them");
    expect(out).toContain("rather than inventing what it contains");
    expect(out).not.toContain("provided below");
  });

  it("counts the tail of a long document list instead of naming all of it", () => {
    const names = Array.from({ length: MANIFEST_NAME_LIMIT + 7 }, (_, i) => `doc-${i}.md`);
    const out = buildSystemPrefix({ persona: "P", mode: "normal", docNames: names });
    expect(out).toContain("doc-0.md");
    expect(out).toContain(`doc-${MANIFEST_NAME_LIMIT - 1}.md`);
    expect(out).not.toContain(`doc-${MANIFEST_NAME_LIMIT}.md`);
    expect(out).toContain("and 7 more");
  });

  it("names every document while the list is short enough to be useful", () => {
    const names = Array.from({ length: MANIFEST_NAME_LIMIT }, (_, i) => `doc-${i}.md`);
    const out = buildSystemPrefix({ persona: "P", mode: "normal", docNames: names });
    expect(out).toContain(`doc-${MANIFEST_NAME_LIMIT - 1}.md`);
    expect(out).not.toContain("more");
  });

  it("ignores blank document names rather than listing a gap", () => {
    const out = buildSystemPrefix({ persona: "P", mode: "normal", docNames: ["", "  "] });
    expect(out).not.toContain("The team has shared");
  });

  it("omits the manifest when there are no documents", () => {
    const out = buildSystemPrefix({ persona: "P", mode: "normal", docNames: [] });
    expect(out).not.toContain("team documents");
  });

  it("asks for concision in normal mode, after the persona", () => {
    const out = buildSystemPrefix({ persona: "You are our PM.", mode: "normal", docNames: [] });
    const personaAt = out.indexOf("You are our PM.");
    const concisionAt = out.indexOf(CONCISION_INSTRUCTIONS);
    expect(concisionAt).toBeGreaterThan(personaAt); // persona reads first
  });

  it("does not ask for concision in brainstorm mode", () => {
    // Brainstorm wants 5-10 ideas plus critique, and carries its own brevity
    // line. Layering a general "be brief" on top would fight it.
    const out = buildSystemPrefix({ persona: "P", mode: "brainstorm", docNames: [] });
    expect(out).not.toContain(CONCISION_INSTRUCTIONS);
    expect(out).toContain(BRAINSTORM_INSTRUCTIONS);
  });

  it("keeps the prefix byte-identical for identical input", () => {
    // The prefix is what OpenAI's automatic prompt cache matches on. Anything
    // that varies per turn belongs outside it (chat.ts keeps the RAG block out
    // for exactly this reason), so this guards against a future addition that
    // is not a pure function of the arguments.
    const args = { persona: "P", mode: "normal" as const, docNames: ["a.md"] };
    expect(buildSystemPrefix(args)).toBe(buildSystemPrefix(args));
  });
});

describe("temperatureFor", () => {
  it("returns 0.9 for brainstorm and undefined for normal", () => {
    expect(temperatureFor("brainstorm")).toBe(0.9);
    expect(temperatureFor("normal")).toBeUndefined();
  });

  it("leaves the mode in charge when the agent named no temperature", () => {
    // Null is what every agent has until somebody moves the dial, and it has to
    // mean exactly what the two lines above mean — otherwise 0048 changes every
    // reply in the product on the day it is applied.
    expect(temperatureFor("brainstorm", null)).toBe(0.9);
    expect(temperatureFor("normal", null)).toBeUndefined();
    expect(temperatureFor("normal", undefined)).toBeUndefined();
  });

  it("lets the agent's own setting win in either mode", () => {
    expect(temperatureFor("normal", 0.2)).toBe(0.2);
    expect(temperatureFor("brainstorm", 0.2)).toBe(0.2);
  });

  it("takes 0, which is a setting and not an absence", () => {
    // The bug this pins: `override || mode default` would read 0 as "unset" and
    // quietly hand a support agent asked for determinism the mode's own value.
    expect(temperatureFor("normal", 0)).toBe(0);
    expect(temperatureFor("brainstorm", 0)).toBe(0);
  });
});

describe("reasoningEffortFor", () => {
  it("sends nothing when the agent named nothing", () => {
    // Not "medium". A request that carries no effort gets the model's own
    // default, which is what every reply in this product has been getting.
    expect(reasoningEffortFor(null)).toBeUndefined();
    expect(reasoningEffortFor(undefined)).toBeUndefined();
    expect(reasoningEffortFor("")).toBeUndefined();
  });

  it("passes the four the API knows", () => {
    for (const effort of ["minimal", "low", "medium", "high"]) {
      expect(reasoningEffortFor(effort)).toBe(effort);
    }
  });

  it("drops a value neither the database nor the API would have allowed", () => {
    // Reachable only by a row written around both. Forwarding it would be a 400
    // on every turn of that agent's conversations; dropping it is one reply
    // without a setting nobody asked for.
    expect(reasoningEffortFor("maximum")).toBeUndefined();
  });
});

describe("maxTokensFor", () => {
  it("caps output, giving report the most room", () => {
    expect(maxTokensFor("normal")).toBe(4096);
    expect(maxTokensFor("brainstorm")).toBe(4096);
    expect(maxTokensFor("brainstorm")).toBeGreaterThanOrEqual(maxTokensFor("normal"));
  });
});

describe("report mode", () => {
  it("does not ask a report to be brief", () => {
    // CONCISION_INSTRUCTIONS shapes chat-length replies, which is the wrong
    // instruction for a document somebody asked to be written.
    const out = buildSystemPrefix({ persona: "You are our PM.", mode: "report", docNames: [] });
    expect(out).toContain(REPORT_INSTRUCTIONS);
    expect(out).not.toContain(CONCISION_INSTRUCTIONS);
    expect(out).not.toContain(BRAINSTORM_INSTRUCTIONS);
  });

  it("still names the documents it has", () => {
    // The manifest is the reason the agent does not deny having files. A report
    // is written against those files, so dropping it here would be worse than
    // dropping it in chat.
    const out = buildSystemPrefix({ persona: "P", mode: "report", docNames: ["a.md", "b.md"] });
    expect(out).toContain("a.md, b.md");
  });

  it("gives a report more room than either chat mode", () => {
    expect(maxTokensFor("report")).toBe(8192);
    expect(maxTokensFor("report")).toBeGreaterThan(maxTokensFor("brainstorm"));
    expect(maxTokensFor("report")).toBeGreaterThan(maxTokensFor("normal"));
  });

  it("sends no temperature of its own, and still honours the agent's", () => {
    // Same rule as normal chat: undefined means the request carries no
    // temperature at all, which is not the same as sending the provider's
    // default. The agent's dial (0048) wins when it has been moved.
    expect(temperatureFor("report")).toBeUndefined();
    expect(temperatureFor("report", 0.2)).toBe(0.2);
    expect(temperatureFor("report", 0)).toBe(0);
  });
});

/**
 * Telling the agent when and where it is.
 *
 * Nothing on the chat path used to say either. Measured in production on
 * 2026-09-26: asked in Turkish for "every Monday until the end of October at
 * 22:00", the agent had to work out which Mondays those were — which needs
 * today's date — and what 22:00 meant — which needs a zone. It inferred both
 * from the language of the request and got them right by luck. An earlier
 * request the same evening carried no date at all, and there was nothing in the
 * prompt from which the right Mondays could be derived. #196.
 *
 * The date and not the time, deliberately: the prefix is byte-identical turn
 * over turn so that it rides the prompt cache, and a clock in it would miss the
 * cache on every turn. A date costs one miss a day.
 */
describe("the date and zone in the prefix", () => {
  const now = new Date("2026-09-26T19:30:00Z");

  it("names today's date and the zone times are meant in", () => {
    const out = buildSystemPrefix({
      persona: null,
      mode: "normal",
      docNames: [],
      now,
      timezone: "Europe/Istanbul",
    });
    expect(out).toContain("26 September 2026");
    expect(out).toContain("Europe/Istanbul");
  });

  it("says UTC when no zone is known, rather than the server's own", () => {
    const out = buildSystemPrefix({ persona: null, mode: "normal", docNames: [], now });
    expect(out).toContain("Times mean UTC");
  });

  it("degrades to UTC on a zone Intl does not recognise", () => {
    // The zone is a per-request guess and can arrive as anything. A RangeError
    // out of `toLocaleDateString` here would take the whole turn with it.
    const out = buildSystemPrefix({
      persona: null,
      mode: "normal",
      docNames: [],
      now,
      timezone: "Mars/Olympus_Mons",
    });
    expect(out).toContain("Times mean UTC");
    expect(out).toContain("26 September 2026");
  });

  it("says nothing about the date when it was not given a clock", () => {
    const out = buildSystemPrefix({ persona: null, mode: "normal", docNames: [] });
    expect(out).not.toContain("Today is");
  });
});
