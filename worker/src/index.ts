import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv, Bindings } from "./types";
import { authMiddleware } from "./middleware/auth";
import { entitlementsMiddleware } from "./middleware/entitlements";
import { rateLimit } from "./middleware/ratelimit";
import { runDueRoutines } from "./lib/routines/dispatcher";
import { agents } from "./routes/agents";
import { favorites } from "./routes/favorites";
import { sessions } from "./routes/sessions";
import { ideas } from "./routes/ideas";
import { brainstorm } from "./routes/brainstorm";
import { persona } from "./routes/persona";
import { messages } from "./routes/messages";
import { chat } from "./routes/chat";
import { transcribe } from "./routes/transcribe";
import { documents } from "./routes/documents";
import { bundles } from "./routes/bundles";
import { me } from "./routes/me";
import { workspace } from "./routes/workspace";
import { invitations } from "./routes/invitations";
import { usage } from "./routes/usage";
import { routines } from "./routes/routines";
import { notifications } from "./routes/notifications";
import { onboarding } from "./routes/onboarding";
import { apiKeys } from "./routes/api-keys";
import { account } from "./routes/account";

const app = new Hono<AppEnv>();

// Reflect the caller's Origin ONLY when it's on the operator-approved allowlist, so
// credentialed requests get an exact ACAO match without opening the door to origin
// spoofing. Allowed = exact origins in ALLOWED_ORIGIN (comma-separated), or localhost
// for dev. We deliberately do NOT pattern-match `*.vercel.app`: because Vercel serves
// project-name subdomains first-come on a shared apex, a broad regex (even one anchored
// to this account's slug) can be satisfied by an attacker who names their own project to
// embed that slug — e.g. `your-project-evil-your-team.vercel.app`. With
// `credentials: true` that would be a real cross-origin read. So preview/deployment URLs
// must be added explicitly to ALLOWED_ORIGIN; normal use goes through the production alias.
const normalizeOrigin = (o: string): string => o.trim().replace(/\/+$/, "");

const isAllowedOrigin = (origin: string, allowed: string): boolean => {
  const list = allowed.split(",").map(normalizeOrigin).filter(Boolean);
  if (list.includes(normalizeOrigin(origin))) return true;
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return true;
  return false;
};

app.use(
  "/*",
  cors({
    origin: (origin, c) => {
      const allowed = c.env.ALLOWED_ORIGIN;
      if (origin && isAllowedOrigin(origin, allowed)) return origin;
      // Fallback to the primary configured origin (unknown origins simply won't match).
      return allowed.split(",")[0].trim();
    },
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    credentials: true,
  }),
);

// After cors, so a preflight is answered rather than counted: an OPTIONS that
// gets a 429 makes the browser report the real request as a CORS failure, which
// is the least legible way this could go wrong.
//
// Keyed by address here, because nothing above has validated a token yet — and
// that is the point. authMiddleware below spends a round trip to Supabase on
// every request, valid or not, so without this the cheapest thing to attack is
// the check that stands in front of everything else.
app.use("/*", rateLimit("standard"));

// Unauthenticated — used for uptime checks / boot verification.
app.get("/health", (c) => c.json({ ok: true }));

// Authenticated sub-router: Task 3 hangs /agents, /sessions, etc. off `api`.
// Everything mounted here requires a valid Supabase bearer token, and gets
// `c.get("user")`, `c.get("db")` (the request-scoped, RLS-aware client) and
// `c.get("entitlements")` (what that user may spend).
const api = new Hono<AppEnv>();
api.use("/*", authMiddleware);
api.use("/*", entitlementsMiddleware);

// Every route that buys a completion or a transcription, which is the only
// reason any of this exists. Keyed by user rather than by address, because
// after authMiddleware there is one — a per-address limit would punish a shared
// office for one person's loop and reward anyone with a second address.
//
// `ratelimit.static.test.ts` holds this list to the code: it fails if a route
// file starts buying completions without appearing here, which is the way this
// goes stale — the seventh paid endpoint, added a year from now for one
// feature, quietly outside the limit.
//
// Document upload and reindex deliberately stay on `standard`. They spend on
// embeddings, which `lib/entitlements` weights at a hundredth of a chat token
// because that is roughly the real price ratio, and 20/min would break bulk
// upload — the one behaviour this product exists to encourage — to bound a cost
// the generous tier already bounds.
//
// Entitlements bound the month and this bounds the minute. They are not
// substitutes: a monthly allowance is a ceiling on the bill, not on the rate at
// which it is reached, and the open build ships no allowance at all.
api.use("/chat/stream", rateLimit("expensive"));
api.use("/transcribe", rateLimit("expensive"));
api.use("/brainstorm/ideas/suggest", rateLimit("expensive"));
api.use("/persona/suggest", rateLimit("expensive"));
api.use("/routines/draft", rateLimit("expensive"));
api.use("/routines/:id/run", rateLimit("expensive"));

api.route("/", agents);
api.route("/", favorites);
api.route("/", sessions);
api.route("/", ideas);
api.route("/", brainstorm);
api.route("/", persona);
api.route("/", messages);
api.route("/", chat);
api.route("/", transcribe);
api.route("/", documents);
api.route("/", bundles);
api.route("/", me);
api.route("/", workspace);
api.route("/", invitations);
api.route("/", usage);
api.route("/", routines);
api.route("/", notifications);
api.route("/", onboarding);
api.route("/", apiKeys);
api.route("/", account);

app.route("/", api);

// The Node entry (src/node.ts) serves this same app. Everything below the
// default export stays Cloudflare-only.
export { app };

// The Worker now has two entry points. `fetch` is the API, unchanged.
// `scheduled` is the routine engine: it wakes on the cron trigger, asks which
// routines are due, and runs them. Per-routine frequency lives in
// routines.next_run_at, not in the cron expression.
export default {
  fetch: app.fetch,
  scheduled: (_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) => {
    ctx.waitUntil(
      // Log and re-throw. Swallowing the error would have Cloudflare record a
      // broken tick as a successful invocation, so the engine could be dead for
      // days with a green dashboard.
      runDueRoutines(env).catch((err) => {
        console.error("routine tick failed", err);
        throw err;
      }),
    );
  },
};
