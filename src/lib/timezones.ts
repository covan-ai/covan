/**
 * Used where the browser cannot list its own zones (`Intl.supportedValuesOf`
 * arrived in 2022). Not every zone: enough that nobody is left without their
 * own city or a neighbour's on the same clock.
 */
const FALLBACK = [
  "UTC",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Africa/Lagos",
  "America/Anchorage",
  "America/Bogota",
  "America/Chicago",
  "America/Denver",
  "America/Halifax",
  "America/Los_Angeles",
  "America/Mexico_City",
  "America/New_York",
  "America/Phoenix",
  "America/Sao_Paulo",
  "America/Toronto",
  "Asia/Bangkok",
  "Asia/Dubai",
  "Asia/Hong_Kong",
  "Asia/Jakarta",
  "Asia/Jerusalem",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Seoul",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Tehran",
  "Asia/Tokyo",
  "Australia/Adelaide",
  "Australia/Brisbane",
  "Australia/Perth",
  "Australia/Sydney",
  "Europe/Amsterdam",
  "Europe/Athens",
  "Europe/Berlin",
  "Europe/Istanbul",
  "Europe/Kyiv",
  "Europe/Lisbon",
  "Europe/London",
  "Europe/Madrid",
  "Europe/Moscow",
  "Europe/Paris",
  "Europe/Rome",
  "Europe/Stockholm",
  "Europe/Warsaw",
  "Pacific/Auckland",
  "Pacific/Honolulu",
];

/** Every zone this browser knows, or the list above where it cannot say. */
export function listTimeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  try {
    const zones = intl.supportedValuesOf?.("timeZone");
    if (zones && zones.length > 0) return zones.includes("UTC") ? zones : ["UTC", ...zones];
  } catch {
    // fall through to the built-in list
  }
  return FALLBACK;
}

/** The zone this device is set to, or null where the browser will not say. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** "Europe/Istanbul" → "Europe / Istanbul", for a picker row. */
export function timeZoneLabel(zone: string): string {
  return zone.replace(/_/g, " ").replace(/\//g, " / ");
}
