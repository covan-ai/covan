import { createClient } from "@supabase/supabase-js";
import { authStorage } from "./auth-storage";

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  // Everything else stays on the defaults — this only takes over *where* the
  // session is kept, so the sign-in page's "Remember me" can decide it. The
  // default storageKey is left alone on purpose: changing it would orphan every
  // session already on disk.
  { auth: { storage: authStorage } },
);
