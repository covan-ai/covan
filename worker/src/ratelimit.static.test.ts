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

/**
 * The imports that mean a file spends money.
 *
 * `lib/completion.ts` is the seam every completion goes through, on either
 * provider; `transcribeAudio` is transcription's own module, which is routed to
 * OpenAI on purpose. `openai.test.ts` and `anthropic.test.ts` guarantee no
 * client is constructed outside those two, so a file cannot buy a completion
 * without naming one of these.
 */
// The document engine is a seam of its own: the Report button and a retry
// start a job that buys a model call per section, and neither route imports
// the completion seam to do it (`lib/docs/`).
const SPENDING_IMPORTS = [
  "../lib/completion",
  "transcribeAudio",
  "../lib/docs/enqueue",
  "../lib/docs/engine",
];

/**
 * Paths behind the expensive tier that buy something other than a completion.
 *
 * The walk below finds endpoints by the seam every completion goes through,
 * which is the right net for model spend and blind to every other kind. This
 * is the list of the others, so the equality assertion stays an equality
 * rather than being loosened to a superset — a superset would stop noticing
 * the seventh model endpoint, which is the whole point of the file.
 *
 * Each entry is a claim that the path spends the operator's money per call
 * without asking a model anything.
 */
const EXPENSIVE_WITHOUT_A_MODEL: Record<string, string> = {
  "/browser/takeovers":
    "rents a real browser at browser-use for fifteen minutes and makes four provider calls doing it, billed to the operator by the minute with one minute as the floor. No completion is bought, so SPENDING_IMPORTS cannot see it, and the §4 headroom check bounds the shared concurrency pool rather than the bill.",
};

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
 * through, plus transcription's own module. The client-factory tests already
 * guarantee nothing reaches a provider any other way, so this cannot be dodged
 * by constructing a client directly.
 */
function paidRouteFiles(): string[] {
  return routeFiles().filter((f) => {
    const src = readFileSync(join(ROUTES, f), "utf8");
    return SPENDING_IMPORTS.some((marker) => src.includes(marker));
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
 * It is not behind the expensive tier's middleware, because that runs before
 * anything is known about the caller, and this request arrives from Slack's
 * infrastructure on behalf of whoever happened to type in a channel. The tier
 * is taken by hand instead, once there is somebody to count, and three bounds
 * have to hold:
 *
 * - **Nothing reaches the work without the signing secret.** The signature is
 *   checked before the body is even parsed, and a failure is a 401 that costs
 *   one HMAC (`lib/slack/verify.ts`). An address that keeps failing it is
 *   refused at the door (`countMiss`).
 * - **The spend is attributed to a person and checked against their rate and
 *   their allowance.** `handleSlackEvent` resolves the Slack user to a Covan
 *   account, takes the expensive tier in that person's own bucket — the one the
 *   chat screen spends — and calls `entitlements.check` before the model,
 *   exactly as a chat turn does. An unrecognised asker is answered with a
 *   sentence and no completion.
 * - **A team's volume is bounded per team.** The route counts each verified
 *   event against its Slack team, not against an address Slack shares between
 *   every customer it has.
 */
const SPENDS_OUTSIDE_THE_MAP: Record<string, string> = {
  "slack.ts": "handleSlackEvent",
  // Added by hand, and that is the weakness this entry documents.
  //
  // `paidRouteFiles()` below finds spenders by looking for an import of the
  // completion seam or of `transcribeAudio`. A route that spends by running a
  // routine imports neither — `startPokedRun` hands the routine to a Durable
  // Object or to `runPokedRoutine`, and the model call is several files
  // further down — so this endpoint would have sailed past the tripwire that
  // exists to catch exactly it.
  //
  // The same hole is open for anything else that reaches the model through the
  // routine engine. Until the detection is widened, a new one has to be
  // remembered here, which is a review item rather than a guarantee.
  "routine-hooks.ts": "startPokedRun",
  // The same hole one step further down: Composio's deliveries reach
  // `runPokedRoutine` through `events/receive.ts`, so this file imports
  // neither seam. Its bounds are pinned below with the hooks'.
  "composio-events.ts": "receiveEvent",
  // GitHub webhooks and WebSub hubs, the same road: `receiveEvent`, and the
  // signature checked inside it by the adapter. Pinned below as well.
  "routine-events.ts": "receiveEvent",
  // Notion's deliveries: the integration's signature checked in the route,
  // then `receiveEvent` per connection that can see the page. Pinned below.
  "notion-events.ts": "receiveEvent",
  // Inbound mail: `receiveEvent` for a routine's own address and
  // `receiveReply` for an answer to a report, which reaches `runPokedRoutine`
  // without `receive.ts`. Pinned below as well.
  "email-inbound.ts": "receiveReply",
  // The document poll, `GET /sessions/:id/document-jobs`. On a deployment
  // with no document host it advances the caller's own job one unit per poll,
  // which is a model call — and it is a GET the tab makes every few seconds,
  // so the expensive tier would refuse the poll that shows the document.
  // Bounded anyway: the work is the job's, fixed when the job was started
  // behind the expensive tier (`/sessions/:id/report`, or a chat turn calling
  // `write_document`); a poll only makes it happen sooner, never makes more of
  // it, and the engine asks the allowance before every unit.
  "document-jobs.ts": "advanceDocumentJob",
};

/**
 * Files beside the routes that reach the model but register no endpoint.
 *
 * `chat-turn.ts` is the shared half of the two chat routes — the loop, the
 * salvage, the sentence a failure gets — extracted because the resume path had
 * drifted into a second, worse copy of it. It lives here rather than under
 * `lib/harness/` because it needs a request, and the harness is deliberately
 * runtime-agnostic so the cron Worker can import it.
 *
 * It spends nothing on its own account: the only things that drive it are
 * `/chat/stream` and `/chat/confirm/:id`, both in the map below and both behind
 * the expensive tier. The value is what proves it — a marker that only exists
 * in a file that is driven rather than mounted. The assertion below checks the
 * other half, that it has not quietly grown an endpoint of its own since.
 */
const DRIVERS_WITHOUT_ENDPOINTS: Record<string, string> = {
  "chat-turn.ts": "export async function runChatTurn",
};

const PAID_ENDPOINTS: Record<string, string[]> = {
  "chat.ts": ["/chat/stream", "/chat/confirm/:id"],
  "transcribe.ts": ["/transcribe"],
  "brainstorm.ts": ["/brainstorm/ideas/suggest"],
  "persona.ts": ["/persona/suggest"],
  "routines.ts": ["/routines/draft", "/routines/:id/run", "/routines/:id/event/test"],
  "reports.ts": ["/sessions/:id/report"],
  "document-jobs.ts": ["/document-jobs/:id/retry"],
};

describe("the expensive rate limit", () => {
  it("covers every endpoint that buys a completion or a transcription", () => {
    const mounted = expensivePaths();
    const paid = [
      ...Object.values(PAID_ENDPOINTS).flat(),
      ...Object.keys(EXPENSIVE_WITHOUT_A_MODEL),
    ];

    expect(paid).not.toEqual([]);
    expect(mounted.slice().sort()).toEqual(paid.slice().sort());
  });

  it.each(Object.keys(EXPENSIVE_WITHOUT_A_MODEL))(
    "still spends without a model, so it still needs the tier: %s",
    (path) => {
      // An exemption outliving its reason is how a list like this rots.
      expect(expensivePaths()).toContain(path);
      expect(EXPENSIVE_WITHOUT_A_MODEL[path].length).toBeGreaterThan(30);
    },
  );

  it("still bounds the one endpoint that spends outside the map", () => {
    // If the identity check or the allowance check ever leaves
    // `lib/slack/handle.ts`, the argument above stops being true and this fails.
    for (const [file, marker] of Object.entries(SPENDS_OUTSIDE_THE_MAP)) {
      expect(readFileSync(join(ROUTES, file), "utf8")).toContain(marker);
    }
    const handle = readFileSync(join(SRC, "lib", "slack", "handle.ts"), "utf8");
    expect(handle).toContain("entitlements.check");
    expect(handle).toContain('getRateLimiter(deps.env, "expensive").check(userRateKey("expensive"');
    const slackRoute = readFileSync(join(ROUTES, "slack.ts"), "utf8");
    expect(slackRoute).toContain("verifySlackSignature");
    expect(slackRoute).toContain("slack-team:${teamId}");
    expect(slackRoute).toContain("countMiss(c)");

    // The incoming-webhook route's bounds, in the same spirit. It cannot
    // reach a routine without resolving a token, it takes the expensive tier's
    // limiter by hand — keyed per token, because the trigger's routine is what
    // spends its owner's allowance — and an address whose tokens keep failing
    // is refused before the lookup.
    const hooks = readFileSync(join(ROUTES, "routine-hooks.ts"), "utf8");
    expect(hooks).toContain("resolveIngestToken");
    expect(hooks).toContain('getRateLimiter(c.env, "expensive")');
    expect(hooks).toContain("hasSpentMisses(c)");
    expect(hooks).toContain("countMiss(c)");
    // Composio's deliveries, the same three bounds: a signature before the
    // body is parsed, the expensive tier taken by hand per trigger instance
    // (one routine's spend), and an address whose signatures keep failing
    // refused before the HMAC. Past that, `receive.ts`'s flood fuse.
    const composioEvents = readFileSync(join(ROUTES, "composio-events.ts"), "utf8");
    expect(composioEvents).toContain("verifyComposioWebhook");
    expect(composioEvents).toContain('getRateLimiter(c.env, "expensive")');
    expect(composioEvents).toContain("hasSpentMisses(c)");
    expect(composioEvents).toContain("countMiss(c)");
    // GitHub and WebSub: the expensive tier per subscription, the address
    // charged for an unknown id or a failed signature, and refused once spent.
    const routineEvents = readFileSync(join(ROUTES, "routine-events.ts"), "utf8");
    expect(routineEvents).toContain('getRateLimiter(c.env, "expensive")');
    expect(routineEvents).toContain("hasSpentMisses(c)");
    expect(routineEvents).toContain("countMiss(c)");
    expect(routineEvents).toContain('outcome.status === "forged"');
    // Notion: the signature before anything is read, the expensive tier per
    // Notion workspace, the address charged for failed signatures.
    const notionEvents = readFileSync(join(ROUTES, "notion-events.ts"), "utf8");
    expect(notionEvents).toContain("X-Notion-Signature");
    expect(notionEvents).toContain('getRateLimiter(c.env, "expensive")');
    expect(notionEvents).toContain("hasSpentMisses(c)");
    expect(notionEvents).toContain("countMiss(c)");
    // Inbound mail: Resend's signature before the body is parsed, the
    // expensive tier per address, a miss for an address nothing holds, and
    // replies capped per routine per hour.
    const emailInbound = readFileSync(join(ROUTES, "email-inbound.ts"), "utf8");
    expect(emailInbound).toContain("verifyResendWebhook");
    expect(emailInbound).toContain('getRateLimiter(c.env, "expensive")');
    expect(emailInbound).toContain("hasSpentMisses(c)");
    expect(emailInbound).toContain("countMiss(c)");
    expect(emailInbound).toContain("passesAuthentication");
    expect(readFileSync(join(SRC, "lib", "routines", "replies.ts"), "utf8")).toContain(
      "REPLIES_PER_HOUR",
    );
    expect(readFileSync(join(SRC, "lib", "routines", "events", "receive.ts"), "utf8")).toContain(
      "count_routine_event",
    );

    // And the credits themselves: a poked run is charged to the routine's
    // workspace by the executor, with no new code, because every id comes off
    // the row.
    expect(readFileSync(join(SRC, "lib", "routines", "executor.ts"), "utf8")).toContain(
      "entitlements.check(routine.workspace_id)",
    );

    // The third thing that spends where this file cannot see it, and the one
    // that weakens the invariant most. A Composio call costs the operator money
    // from inside a TOOL, which no route imports and no rate limit counts: the
    // model decides to make it, several times per turn, after the request is
    // already past every gate in index.ts. `MAX_STEPS` bounds how many a turn
    // can make; the allowance is what bounds how many an account can.
    //
    // So both halves are pinned. `affordable` must be asked BEFORE the network
    // in each tool, and it must ask about the turn's workspace — the one the
    // route charged.
    const spend = readFileSync(join(SRC, "lib", "harness", "spend.ts"), "utf8");
    expect(spend).toContain("entitlementsFor(ctx.env).check(ctx.workspaceId)");
    expect(spend).toContain("entitlementsFor(ctx.env).record(ctx.workspaceId");
    for (const tool of ["run-tool.ts", "find-tool.ts", "browse.ts"]) {
      const src = readFileSync(join(SRC, "lib", "harness", "tools", tool), "utf8");
      expect(src, `${tool} must check the credits before it spends`).toContain("affordable(ctx)");
      expect(src, `${tool} must record what it spent`).toContain("spend(ctx,");
    }
  });

  it("knows about every route file that spends, so a new one cannot arrive unnoticed", () => {
    // This is the tripwire. If a route file starts importing the completion
    // seam, this fails and whoever added it has to decide — deliberately —
    // whether its endpoints belong behind the limit.
    expect(paidRouteFiles().sort()).toEqual(
      [...Object.keys(PAID_ENDPOINTS), ...Object.keys(DRIVERS_WITHOUT_ENDPOINTS)].sort(),
    );
  });

  it("keeps a driver a driver, so nothing mounts an endpoint the map never sees", () => {
    // The exemption above is only true while these files register nothing. A
    // `.post()` appearing in one would be an endpoint that spends and that the
    // map — and therefore the limit — knows nothing about, which is the exact
    // hole the tripwire exists to close.
    for (const [file, marker] of Object.entries(DRIVERS_WITHOUT_ENDPOINTS)) {
      const src = readFileSync(join(ROUTES, file), "utf8");
      expect(src, `${file} should still be the driver it was exempted as`).toContain(marker);
      expect(src, `${file} must not register endpoints`).not.toMatch(
        /\.(get|post|put|patch|delete|on)\(\s*["'`]/,
      );
    }
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
