import { describe, it, expect, afterEach } from "vitest";
import { browserTimeZone, listTimeZones, timeZoneLabel } from "./timezones";

const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
const original = intl.supportedValuesOf;

afterEach(() => {
  intl.supportedValuesOf = original;
});

describe("time zones", () => {
  it("lists what the browser knows, with UTC in it", () => {
    intl.supportedValuesOf = () => ["Europe/Istanbul", "Asia/Tokyo"];
    expect(listTimeZones()).toEqual(["UTC", "Europe/Istanbul", "Asia/Tokyo"]);
  });

  it("falls back to a built-in list where the browser cannot say", () => {
    intl.supportedValuesOf = undefined;
    const zones = listTimeZones();
    expect(zones).toContain("UTC");
    expect(zones).toContain("Europe/Istanbul");
    expect(zones.length).toBeGreaterThan(30);
  });

  it("names the device's own zone", () => {
    expect(typeof browserTimeZone()).toBe("string");
  });

  it("reads a zone as words", () => {
    expect(timeZoneLabel("America/Los_Angeles")).toBe("America / Los Angeles");
  });
});
