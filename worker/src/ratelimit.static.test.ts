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
