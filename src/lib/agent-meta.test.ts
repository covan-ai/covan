import { describe, it, expect } from "vitest";
import { EMOJIS, MODELS, PERSONA_TEMPLATES, modelsFor, specFor } from "./agent-meta";

/**
 * Two invariants that nothing else would catch, because both fail silently.
 *
 * A template's emoji and model are pre-filled into `Select` controls whose
 * options are `EMOJIS` and `MODELS`. A value outside either list is not an
 * error — the control simply renders empty, on the create dialog and then again
 * on that agent's settings tab forever after. There is no thrown exception and
 * no failing request; the picker is just blank, which reads as a rendering bug
 * rather than a typo four files away.
 *
 * These are cheap to state and the alternative is finding out from a user.
 */

describe("persona templates", () => {
  it.each(PERSONA_TEMPLATES)("$id offers an emoji the pickers can show", ({ emoji }) => {
    expect(EMOJIS).toContain(emoji);
  });

  it.each(PERSONA_TEMPLATES)("$id offers a model the pickers can show", ({ model }) => {
    expect(MODELS).toContain(model);
  });

  it("has no two templates sharing an id", () => {
    // The dialog finds the picked template by id and toggles on it. Two rows
    // with one id means the second is unreachable and the first cannot be
    // deselected without appearing to select the other.
    const ids = PERSONA_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * The list above is what this build knows; `modelsFor` is what a given install
 * may show. They stopped being the same thing when a second provider arrived:
 * the Claude ids exist only where the server has a key for them, which is a
 * fact the frontend learns from /me rather than one it can hold in a constant.
 */
describe("modelsFor", () => {
  it("lists what the server says it can serve", () => {
    expect(modelsFor(["gpt-4o", "claude-haiku-4-5"])).toEqual(["gpt-4o", "claude-haiku-4-5"]);
  });

  it("shows the OpenAI models alone until /me answers", () => {
    // Every deployment has an OpenAI key by definition; the Claude ids depend
    // on one the frontend cannot see. Offering them on a hunch and withdrawing
    // them a moment later is worse than offering fewer.
    const fallback = modelsFor(undefined);
    expect(fallback).toContain("gpt-4o");
    expect(fallback.filter((m) => m.startsWith("claude-"))).toEqual([]);
  });

  it("treats an empty list the same way, rather than rendering nothing", () => {
    expect(modelsFor([])).toEqual(modelsFor(undefined));
  });

  it("keeps the current pick visible even when the server no longer offers it", () => {
    // An agent left on a Claude model after the key was rotated out. A <Select>
    // whose value matches no item renders blank — the same silent blank the
    // template invariants above exist to prevent, arriving by a different route.
    expect(modelsFor(["gpt-4o"], "claude-sonnet-4-5")).toEqual(["gpt-4o", "claude-sonnet-4-5"]);
  });

  it("does not duplicate a current pick that is already offered", () => {
    expect(modelsFor(["gpt-4o", "gpt-4o-mini"], "gpt-4o")).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("ignores a null current pick, which is how 'no preference' arrives", () => {
    expect(modelsFor(["gpt-4o"], null)).toEqual(["gpt-4o"]);
  });
});

describe("specFor", () => {
  const specs = {
    "gpt-4o": { temperature: true, reasoning: false },
    "gpt-5-mini": { temperature: false, reasoning: true },
  };

  it("answers from what the server said", () => {
    expect(specFor(specs, "gpt-5-mini")).toEqual({ temperature: false, reasoning: true });
  });

  it("assumes a model it was told nothing about takes a temperature and does not reason", () => {
    // The server's own answer for an unknown id, and the situation is normal
    // rather than exceptional: under a custom endpoint every id is unknown, and
    // an agent can sit on a Claude model after the key was rotated out.
    // Optimistic about the control that is harmless to offer, conservative
    // about the one that is not.
    expect(specFor(specs, "llama3.3:70b")).toEqual({ temperature: true, reasoning: false });
  });

  it("answers the same way before /me has said anything at all", () => {
    expect(specFor(undefined, "gpt-5-mini")).toEqual({ temperature: true, reasoning: false });
    expect(specFor(specs, null)).toEqual({ temperature: true, reasoning: false });
  });
});
