import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  CATALOGUE,
  EVENT_TYPES,
  MAX_TRIGGER_LABEL,
  catalogueOf,
  parseEventChoice,
  triggerLabel,
  type EventTypeDef,
} from "./catalog";
import { ADAPTER_REGISTRY } from "./adapter";

const CAL: EventTypeDef = {
  id: "calendar.starting_soon",
  provider: "composio",
  app: "Calendar",
  label: "Event starting soon",
  description: "A meeting is about to start.",
  requires: { kind: "composio", toolkit: "googlecalendar" },
  config: z.object({ minutesBefore: z.number().int().min(1).max(120).default(10) }),
  fields: [{ key: "minutesBefore", label: "Minutes before", kind: "number", optional: true }],
  sample: { eventId: "sample", text: "Standup starts in 10 minutes." },
};

describe("parseEventChoice", () => {
  const catalogue = catalogueOf([CAL]);

  it("accepts a choice its entry's schema accepts, as the schema left it", () => {
    const out = parseEventChoice(catalogue, "calendar.starting_soon", {});
    expect(out).toEqual({ ok: true, choice: { def: CAL, config: { minutesBefore: 10 } } });
  });

  it("drops keys the entry does not know", () => {
    const out = parseEventChoice(catalogue, "calendar.starting_soon", { connectionId: "smuggled" });
    expect(out.ok && out.choice.config).toEqual({ minutesBefore: 10 });
  });

  it("names the field it refused", () => {
    const out = parseEventChoice(catalogue, "calendar.starting_soon", { minutesBefore: 900 });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toMatch(/^minutesBefore: /);
  });

  it("refuses an event nobody catalogued", () => {
    expect(parseEventChoice(catalogue, "fax.received", {})).toEqual({
      ok: false,
      error: "unknown event type",
    });
  });
});

describe("triggerLabel", () => {
  it("is the app and what happened", () => {
    expect(triggerLabel(CAL)).toBe("Calendar · Event starting soon");
  });

  it("fits the column it is written to", () => {
    expect(triggerLabel(CAL, "x".repeat(500))).toHaveLength(MAX_TRIGGER_LABEL);
  });
});

describe("the catalogue", () => {
  // An entry without an adapter would be a choice the dialog offers and the
  // engine cannot keep. They ship together, so this holds at every commit.
  it("has an adapter for every provider it names", () => {
    for (const def of EVENT_TYPES) {
      expect(ADAPTER_REGISTRY.adapterFor(def.provider), def.id).toBeDefined();
    }
  });

  it("never reuses an id", () => {
    const ids = EVENT_TYPES.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // "Send a test event" runs the sample straight through, but a sample a
  // routine's own default filter would refuse is a test of nothing.
  it("gives every entry a sample its default filter would accept", () => {
    for (const def of EVENT_TYPES) {
      const defaults = def.config.safeParse({});
      if (!defaults.success) continue; // a required field has no default to test
      expect(def.matches?.(defaults.data, def.sample) ?? true, def.id).toBe(true);
    }
  });

  it("looks entries up by id", () => {
    for (const def of EVENT_TYPES) expect(CATALOGUE.eventType(def.id)).toBe(def);
  });
});
