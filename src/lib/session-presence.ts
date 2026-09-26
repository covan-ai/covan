import { useEffect, useState } from "react";
import { supabase } from "./supabase/client";
import { readSession } from "./supabase/session";

/** Matches the pause `_authed` and `/` take between attempts, for the same reason. */
const RETRY_AFTER_MS = 3000;

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
  const [attempt, setAttempt] = useState(0);
  /** True while the session could neither be found nor ruled out. */
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let active = true;

    void readSession().then((answer) => {
      if (!active) return;
      // A lookup that could not complete stays `undefined`: `false` would empty
      // a signed-in person's sidebar over a network blip. But it cannot stay
      // that way, so ask again — waiting for the next auth event is waiting for
      // something a browser with a valid stored token never emits.
      if (answer.kind === "unknown") {
        setUnreachable(true);
        return;
      }
      setUnreachable(false);
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
  }, [attempt]);

  // Keep asking, but only while the answer is genuinely missing. A real `true`
  // or `false` ends it: this hook sits above every route, and a poll here would
  // run on the busiest page on the site for every visitor who never signs in.
  useEffect(() => {
    if (!unreachable) return;
    const timer = setTimeout(() => setAttempt((n) => n + 1), RETRY_AFTER_MS);
    return () => clearTimeout(timer);
  }, [unreachable, attempt]);

  return hasSession;
}
