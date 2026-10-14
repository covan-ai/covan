/**
 * The content security policy the app is heading towards, sent report-only.
 *
 * What is enforced today is `frame-ancestors 'none'` and nothing else
 * (`src/start.ts`), so a script injected into a page from any origin would
 * run. A real `script-src` has to be watched before it is enforced — a wrong
 * one is a blank page for everybody — so this is the policy in
 * `Content-Security-Policy-Report-Only`: browsers report what it would have
 * blocked, in the console, and block nothing.
 *
 * `'unsafe-inline'` in `script-src` is the one concession, and it is the
 * thing standing between this and enforcement: the server render inlines its
 * hydration scripts without a nonce. What the policy still says is the part
 * that matters most — no script from an origin this app does not name.
 *
 * Origins come from the same `VITE_*` values the bundle is built with, so a
 * self-hosted build names its own API and Supabase rather than covan.app's.
 */
export function reportOnlyPolicy(env: {
  apiUrl?: string;
  supabaseUrl?: string;
  posthogHost?: string;
}): string {
  const origin = (url?: string) => {
    try {
      return url ? new URL(url).origin : null;
    } catch {
      return null;
    }
  };
  const api = origin(env.apiUrl);
  const supabase = origin(env.supabaseUrl);
  const socket = supabase ? supabase.replace(/^http/, "ws") : null;
  const posthog = env.posthogHost ? "https://*.posthog.com" : null;
  const list = (...items: Array<string | null>) => items.filter(Boolean).join(" ");

  return [
    "default-src 'self'",
    `script-src ${list("'self'", "'unsafe-inline'", posthog)}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${list("'self'", "data:", "blob:", api)}`,
    "font-src 'self' data:",
    `connect-src ${list("'self'", api, supabase, socket, posthog)}`,
    // The live view of an agent's browser is a provider's page, on a host the
    // provider chooses; `safeNavigationUrl` already holds it to https.
    "frame-src 'self' blob: https:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
