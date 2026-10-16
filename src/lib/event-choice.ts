import type { EventCatalogEntry, EventChoice } from "@/lib/routines-api";

/**
 * Whether a choice of event can be sent: the entry exists, what it needs is
 * connected, and every field it requires has a value. The API checks all
 * three again — this only keeps Create from being pressable for a request
 * that will be refused.
 */
export function eventChoiceReady(
  catalog: EventCatalogEntry[],
  choice: EventChoice | null,
): boolean {
  if (!choice) return false;
  const entry = catalog.find((e) => e.type === choice.type);
  if (!entry || !entry.connected) return false;
  return entry.fields.every((f) => {
    if (f.optional || f.kind === "boolean") return true;
    const v = choice.config[f.key];
    return v !== undefined && v !== null && String(v).trim() !== "";
  });
}
