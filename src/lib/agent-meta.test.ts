import { describe, it, expect } from "vitest";
import { EMOJIS, MODELS, PERSONA_TEMPLATES } from "./agent-meta";

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
