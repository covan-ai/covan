import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * The rate limit only bounds the bill if it is in front of everything that
 * spends. Six endpoints buy a completion or a transcription today, and each is
 * mounted behind `rateLimit("expensive")` in index.ts by hand — which is fine
 * until the seventh, added a year from now for one feature, is not.
 *
 * So this walks the source instead of trusting a review to notice. It is the
 * same shape as `lib/openai.test.ts`'s check that nothing constructs its own
 * client: the risk is not this commit, it is the next one.
 */

const SRC = import.meta.dirname;
const ROUTES = join(SRC, "routes");

const index = readFileSync(join(SRC, "index.ts"), "utf8");

/** Paths mounted behind the expensive tier, read out of index.ts. */
function expensivePaths(): string[] {
  return [...index.matchAll(/api\.use\(\s*"([^"]+)"\s*,\s*rateLimit\("expensive"\)\s*\)/g)].map(
    (m) => m[1],
  );
}

function routeFiles(): string[] {
  return readdirSync(ROUTES).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
}

/**
 * Route files that buy a completion, found by the seam every completion goes
 * through, plus transcription's own module. `lib/openai.test.ts` already
 * guarantees nothing reaches OpenAI for a completion any other way, so this
 * cannot be dodged by constructing a client directly.
 */
function paidRouteFiles(): string[] {
  return routeFiles().filter((f) => {
    const src = readFileSync(join(ROUTES, f), "utf8");
    return src.includes("createOpenAI") || src.includes("transcribeAudio");
  });
}

/**
 * Which of those files' endpoints actually spend, stated rather than inferred.
 *
 * routes/routines.ts registers eleven endpoints and two of them buy a
 * completion, so "every POST in a paid file" would be wrong in the expensive
 * direction — it would put the routine list behind a 20/min limit. The tripwire
 * below is what keeps this honest: the file list is derived, so a new file
 * cannot be forgotten, and this map has to be updated when one appears.
 */
/**
 * The one endpoint that spends without appearing in the map below, and the
 * argument for it.
 *
 * `POST /slack/events` buys a completion — through `lib/slack/handle.ts`, so
 * the `createOpenAI` seam above does not see it, which is exactly the kind of
 * thing this file exists to stop being invisible.
 *
 * It is deliberately not on the expensive tier. That tier is keyed by user, and
 * this request has no user: it arrives from Slack's infrastructure, from many
 * addresses, on behalf of whoever happened to type in a channel. A per-minute
 * limit there would either be wide enough to bound nothing or narrow enough to
 * throttle a busy Slack workspace.
 *
 * What bounds it instead is stronger than a minute counter, and both halves
 * have to hold:
 *
 * - **Nothing reaches the work without the signing secret.** The signature is
 *   checked before the body is even parsed, and a failure is a 401 that costs
 *   one HMAC (`lib/slack/verify.ts`).
 * - **The spend is attributed to a person and checked against their
 *   allowance.** `handleSlackEvent` resolves the Slack user to a Covan account
 *   and calls `entitlements.check` before the model, exactly as a chat turn
 *   does. An unrecognised asker is answered with a sentence and no completion.
 *
 * The standard tier still applies — `app.use("/*")` is mounted at the root, in
 * front of this route as much as any other.
 */
const SPENDS_OUTSIDE_THE_MAP: Record<string, string> = {
  "slack.ts": "handleSlackEvent",
};

const PAID_ENDPOINTS: Record<string, string[]> = {
  "chat.ts": ["/chat/stream"],
  "transcribe.ts": ["/transcribe"],
  "brainstorm.ts": ["/brainstorm/ideas/suggest"],
  "persona.ts": ["/persona/suggest"],
  "routines.ts": ["/routines/draft", "/routines/:id/run"],
};

describe("the expensive rate limit", () => {
  it("covers every endpoint that buys a completion or a transcription", () => {
    const mounted = expensivePaths();
    const paid = Object.values(PAID_ENDPOINTS).flat();

    expect(paid).not.toEqual([]);
    expect(mounted.slice().sort()).toEqual(paid.slice().sort());
  });

  it("still bounds the one endpoint that spends outside the map", () => {
    // If the identity check or the allowance check ever leaves
    // `lib/slack/handle.ts`, the argument above stops being true and this fails.
    for (const [file, marker] of Object.entries(SPENDS_OUTSIDE_THE_MAP)) {
      expect(readFileSync(join(ROUTES, file), "utf8")).toContain(marker);
    }
    const handle = readFileSync(join(SRC, "lib", "slack", "handle.ts"), "utf8");
    expect(handle).toContain("entitlements.check");
    expect(readFileSync(join(ROUTES, "slack.ts"), "utf8")).toContain("verifySlackSignature");
  });

  it("knows about every route file that spends, so a new one cannot arrive unnoticed", () => {
    // This is the tripwire. If a route file starts importing createOpenAI, this
    // fails and whoever added it has to decide — deliberately — whether its
    // endpoints belong behind the limit.
    expect(paidRouteFiles().sort()).toEqual(Object.keys(PAID_ENDPOINTS).sort());
  });

  it("mounts each of those paths on a route that exists", () => {
    // A path typed one way in index.ts and another in the route file is a limit
    // that silently applies to nothing.
    for (const [file, paths] of Object.entries(PAID_ENDPOINTS)) {
      const src = readFileSync(join(ROUTES, file), "utf8");
      for (const path of paths) {
        expect(src, `${file} should register ${path}`).toContain(`"${path}"`);
      }
    }
  });

  it("puts the standard tier in front of everything, including the token check", () => {
    // authMiddleware spends a round trip to Supabase on every request, valid or
    // not. If the standard limiter ever moves below it, the cheapest thing to
    // attack becomes the check standing in front of everything else.
    const standard = index.indexOf('app.use("/*", rateLimit("standard"))');
    const auth = index.indexOf('api.use("/*", authMiddleware)');

    expect(standard).toBeGreaterThan(-1);
    expect(auth).toBeGreaterThan(-1);
    expect(standard).toBeLessThan(auth);
  });
});
