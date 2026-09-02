import type { Bindings } from "../../types";
import { notionProvider } from "./notion";
import { googleDriveProvider } from "./google-drive";
import type { ConnectionProvider, ProviderId } from "./types";

/**
 * Every source a connection can be made from, in the order the interface shows
 * them. One list, so adding a provider is one entry rather than a search for
 * the four places that enumerate them.
 */
export const PROVIDERS: ConnectionProvider[] = [notionProvider, googleDriveProvider];

export function providerFor(id: string): ConnectionProvider | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

/**
 * What this deployment can actually offer.
 *
 * A provider with no client credentials is not hidden — it is listed as
 * unconfigured, with the environment variables it wants. Hiding it would leave
 * a self-hoster reading the docs for a feature their own build appears not to
 * have.
 */
export function providerAvailability(
  env: Bindings,
): Array<{ id: ProviderId; label: string; configured: boolean }> {
  return PROVIDERS.map((p) => ({ id: p.id, label: p.label, configured: p.isConfigured(env) }));
}
