// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every variable the compose stack documents and the worker reads must reach
 * the container.
 *
 * This is not tidiness either. `docker-compose.yml` passes environment to
 * `covan-api` by naming each variable explicitly — `FOO: ${FOO:-}` — which is
 * the right design, because a blanket `env_file` would hand the API container
 * the Postgres password and the service-role JWT it has no business holding.
 * The cost of that design is one line per variable, and a line nobody wrote is
 * a feature that silently does not exist.
 *
 * Which is exactly what happened. `COMPOSIO_API_KEY` and `BROWSER_USE_API_KEY`
 * were both documented at length in `.env.docker.example`, both read by
 * `worker/src`, and neither was ever listed here — so connected apps and the
 * browser tool could not work in the compose stack however the operator
 * configured their `.env`, from the day each shipped. Nothing failed: the
 * worker reads `undefined`, decides the feature is not configured, and says so
 * politely. `docs/self-hosting.md` meanwhile tells people to set the variable.
 *
 * That is the worst shape a bug can have in a self-hosted product — the
 * operator did everything right, the software says the thing they configured
 * is not configured, and there is nothing in a log to argue with. So it is a
 * ratchet rather than a fix.
 *
 * The three-way intersection is the whole test: a variable has to be
 * DOCUMENTED (so an operator could set it), READ by the worker (so it does
 * something), and PASSED THROUGH (so it arrives). Infrastructure variables
 * belong to the other services and are excluded by name below.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Variables the stack's own services consume — Postgres, GoTrue, Kong,
 * Realtime — or that shape the compose file itself. None of them is the API
 * worker's to receive, and several of them are things it must NOT receive.
 */
const INFRASTRUCTURE = new Set([
  "POSTGRES_PASSWORD",
  "POSTGRES_PORT",
  "POSTGRES_DB",
  "POSTGRES_HOST",
  "JWT_SECRET",
  "JWT_EXPIRY",
  "ANON_KEY",
  "SERVICE_ROLE_KEY",
  "SECRET_KEY_BASE",
  "REALTIME_DB_ENC_KEY",
  "SUPABASE_PUBLIC_URL",
  "VITE_API_URL",
  "SITE_URL",
  "KONG_HTTP_PORT",
  "COVAN_API_PORT",
  "COVAN_WEB_PORT",
  "BIND_ADDR",
  "DISABLE_SIGNUP",
  "MAILER_AUTOCONFIRM",
  "ADDITIONAL_REDIRECT_URLS",
]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
const example = readFileSync(join(root, ".env.docker.example"), "utf8");

/** Declared in the example an operator copies, so they could set it. */
const documented = new Set([...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));

/** Interpolated anywhere in the compose file, so it reaches a container. */
const passedThrough = new Set([...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));

/**
 * Read off `env` by the worker. The source rather than a list, for
 * `service-client.static.test.ts`'s reason: a list is a thing that goes stale
 * quietly, and the point of this file is to notice.
 */
const readByWorker = new Set(
  walk(join(root, "worker", "src")).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]),
  ),
);

describe("what the compose stack hands the API worker", () => {
  it("passes through every documented variable the worker actually reads", () => {
    const missing = [...documented]
      .filter((name) => readByWorker.has(name))
      .filter((name) => !passedThrough.has(name))
      .filter((name) => !INFRASTRUCTURE.has(name))
      .sort();

    expect(
      missing,
      "documented in .env.docker.example and read by worker/src, but never " +
        "listed in docker-compose.yml — so the feature cannot work in the " +
        "compose stack however the operator configures their .env",
    ).toEqual([]);
  });

  /**
   * The reverse, and it is a weaker claim on purpose: a variable the compose
   * file passes and nothing reads is dead configuration rather than a broken
   * feature. Worth noticing anyway — it is usually a rename that landed on one
   * side.
   */
  it("passes nothing to the API worker that no code reads", () => {
    const api = compose.slice(compose.indexOf("\n  covan-api:"), compose.indexOf("\n  covan-web:"));
    const dead = [...api.matchAll(/^      ([A-Z][A-Z0-9_]*): /gm)]
      .map((m) => m[1])
      .filter((name) => !readByWorker.has(name))
      // Read by the runtime rather than by our code: `PORT` is Bun's, and the
      // Supabase trio is resolved through `lib/supabase.ts`'s own helper.
      .filter((name) => !["PORT", "DOCS_DIR"].includes(name))
      .sort();

    expect(dead).toEqual([]);
  });

  /** The four that were missing, named, so a revert is loud rather than quiet. */
  it.each(["BROWSER_USE_API_KEY", "BROWSER_USE_BASE_URL", "COMPOSIO_API_KEY", "COMPOSIO_BASE_URL"])(
    "still passes %s",
    (name) => {
      expect(passedThrough.has(name)).toBe(true);
    },
  );
});

/**
 * `lib/env.ts` is the second place a variable gets dropped, and the one with
 * no symptom at all.
 *
 * On Cloudflare, bindings arrive from `wrangler.toml` and secrets, so the code
 * sees whatever was set. On every Docker and Node self-host, `loadEnv()` builds
 * the `Bindings` object field by field from `process.env` — an explicit
 * allowlist, which is the right design for the same reason compose naming each
 * variable is. The cost is identical: a variable missing from that list is
 * `undefined` to the code however the operator set it.
 *
 * The comment above `COMPOSIO_API_KEY` in that file spells this out — *"omit it
 * here and every Docker and Node self-host reports the feature unconfigured
 * with no error anywhere, while the Cloudflare build works fine"* — and then
 * `BROWSER_USE_API_KEY`, added next, was omitted anyway. Compose was not
 * passing it either, so there were two independent reasons and fixing one
 * would have changed nothing; which is why this test checks both layers rather
 * than the one that was found first.
 */
describe("what lib/env.ts forwards to the self-hosted runtime", () => {
  const envTs = readFileSync(join(root, "worker", "src", "lib", "env.ts"), "utf8");
  /** `NAME: source.NAME` / `source.NAME ?? …` — read off the file, not listed. */
  const forwarded = new Set([...envTs.matchAll(/\bsource\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));

  it("forwards every optional variable the compose stack passes it", () => {
    const api = compose.slice(compose.indexOf("\n  covan-api:"), compose.indexOf("\n  covan-web:"));
    const handed = [...api.matchAll(/^      ([A-Z][A-Z0-9_]*): /gm)].map((m) => m[1]);

    const dropped = handed
      .filter((name) => readByWorker.has(name))
      .filter((name) => !forwarded.has(name))
      // Read by the runtime rather than from `Bindings`: node.ts takes these
      // off `process.env` directly, because they configure the server and the
      // intervals rather than the app.
      .filter((name) => !["PORT", "ROUTINE_TICK_MS", "PURGE_TICK_MS"].includes(name))
      .sort();

    expect(
      dropped,
      "handed to the container by docker-compose.yml and read off `env` in " +
        "worker/src, but never copied into Bindings by loadEnv() — so the " +
        "code sees undefined however the operator sets it, on every " +
        "self-host, with no error anywhere",
    ).toEqual([]);
  });

  /** Named, so a revert is loud. Both layers, because both were missing. */
  it.each(["BROWSER_USE_API_KEY", "BROWSER_USE_BASE_URL"])("forwards %s", (name) => {
    expect(forwarded.has(name), `loadEnv() drops ${name}`).toBe(true);
    expect(passedThrough.has(name), `compose drops ${name}`).toBe(true);
  });
});
