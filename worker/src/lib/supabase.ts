import { createClient } from "@supabase/supabase-js";
import type { Bindings, RoutineEnv } from "../types";

/**
 * Anon-key client used ONLY to validate a caller's bearer token via
 * `.auth.getUser(token)`. Do not use this client for data access.
 */
export function authClient(env: Bindings) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Request-scoped, anon-key client created with the caller's bearer token
 * forwarded as the Authorization header. Postgres RLS resolves `auth.uid()`
 * from this token, so this is THE client to use for all user-scoped data
 * access. Construct a fresh instance per request — never share across requests.
 */
export function userClient(env: Bindings, token: string) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Service-role client that BYPASSES Row Level Security entirely.
 * Reserved for rare admin/background operations. This must NOT be the
 * default path for user data access — always prefer `userClient`.
 *
 * Takes `RoutineEnv`, not `Bindings`, so the scheduled-only Worker — which has
 * no anon key and no R2 binding — can construct one.
 */
export function serviceClient(env: RoutineEnv) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
