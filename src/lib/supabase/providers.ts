import type { Provider } from "@supabase/supabase-js";

/**
 * The identity providers the sign-in and sign-up cards know how to offer.
 *
 * Only these two, and in this order. GoTrue supports twenty; a button is a
 * mark, a label and a promise that the click goes somewhere, and these are the
 * two the people this is for already have.
 */
export const OAUTH_PROVIDERS = ["google", "github"] as const satisfies readonly Provider[];

export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/**
 * Which of them this install's GoTrue actually has switched on.
 *
 * Asked of GoTrue rather than configured a second time in the frontend. The
 * provider is enabled in one place — the compose file's `GOTRUE_EXTERNAL_*`,
 * or the dashboard on a hosted project — and a `VITE_` flag beside it would be
 * a second place that can disagree. When it does, the button is either missing
 * from an install that has the provider, or present on one that answers the
 * click with GoTrue's own JSON error page, which is a dead end with no way back
 * to the form.
 *
 * `GET /auth/v1/settings` is public (it needs the anon key and nothing else) and
 * reports `external.<provider>: boolean` for every provider GoTrue knows.
 *
 * Never rejects. Anything short of a clear answer is "none": a lookup that
 * fails is no reason to offer a door that may not open, and the email form
 * below is always there.
 */
export async function enabledProviders(): Promise<OAuthProvider[]> {
  try {
    const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY },
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { external?: Record<string, unknown> };
    return OAUTH_PROVIDERS.filter((provider) => body.external?.[provider] === true);
  } catch {
    return [];
  }
}
