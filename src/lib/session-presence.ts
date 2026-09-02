import { useEffect, useState } from "react";
import { supabase } from "./supabase/client";
import { readSession } from "./supabase/session";

/**
 * Whether there is somebody signed in, as a fact a query can be gated on.
 *
 * `undefined` until the first answer arrives, and that third state is the
 * point: `false` would mean "nobody is signed in", which is not what a page
 * knows during the tick it takes to read the stored session. A query gated on
 * `=== true` therefore waits rather than fires, and a query gated on `!== false`
 * would not.
 *
 * This exists because the store it feeds sits above every route. `/`,
 * `/privacy`, `/sign-in` and `/sign-up` all mounted it, all five of its queries
 * ran, all five answered 401, and react-query retried each three times — twenty
 * requests to the API before anybody had an account, on the page a visitor is
 * most likely to see. Measured on the deployed site, not inferred.
 */
export function useHasSession(): boolean | undefined {
  const [hasSession, setHasSession] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let active = true;

    void readSession().then((answer) => {
      if (!active) return;
      // A lookup that could not complete stays `undefined`. `false` would empty
      // a signed-in person's sidebar over a network blip, and nothing here
      // re-asks — the answer that arrives with the next auth event is what
      // corrects it. See readSession for what the third answer means.
      if (answer.kind === "unknown") return;
      setHasSession(answer.kind === "session");
    });

    // Covers signing in, signing out, and the token refresh that would
    // otherwise leave a signed-in page gated on a stale `false`. INITIAL_SESSION
    // is skipped because it carries a null on exactly the failed lookup above,
    // and the lookup is the one that can tell that apart from a real absence.
    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active || event === "INITIAL_SESSION") return;
      setHasSession(Boolean(session));
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  return hasSession;
}
