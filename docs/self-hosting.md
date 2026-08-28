# Self-hosting Covan

Covan runs on your own machine with one command. The only thing you have to
bring is an OpenAI API key — everything else, including the database and auth,
runs in containers alongside the app.

```bash
git clone <your fork or clone url> covan
cd covan
cp .env.docker.example .env
# open .env and set OPENAI_API_KEY=sk-...
docker compose pull        # published images; omit to build from this checkout
docker compose up
```

Both Covan images are published to `ghcr.io/covan-ai` for amd64 and arm64, so
`docker compose pull` skips compiling the frontend locally. Leave it out and
`docker compose up` builds from source instead — the compose file declares both,
so either works from a fresh clone. Six supporting images are pulled either way.

When it settles:

| What      | Where                   |
| --------- | ----------------------- |
| Covan     | <http://localhost:3000> |
| Covan API | <http://localhost:8787> |
| Supabase  | <http://localhost:8000> |
| Postgres  | `localhost:54322`       |

Open <http://localhost:3000>, create an account with any email and password,
and you are in. Email confirmation is off (`GOTRUE_MAILER_AUTOCONFIRM`) because
the stack ships no mail server — a confirmation link would never arrive.

Stop with `docker compose down`. Add `-v` to delete the database and every
uploaded document too.

## What is in the stack

| Service     | Image                          | Why                                                |
| ----------- | ------------------------------ | -------------------------------------------------- |
| `db`        | `supabase/postgres:17.6.1.136` | Postgres with `pgvector` and `pgcrypto`            |
| `auth`      | `supabase/gotrue:v2.189.0`     | Sign-up, sign-in, JWTs                             |
| `rest`      | `postgrest/postgrest:v14.12`   | The Data API row level security is enforced by     |
| `realtime`  | `supabase/realtime:v2.102.3`   | Live updates for shared chats and idea boards      |
| `kong`      | `kong/kong:3.9.3`              | One origin in front of auth/rest/realtime          |
| `migrate`   | `postgres:17.6-alpine`         | Applies `supabase/migrations/`, then exits         |
| `covan-api` | `ghcr.io/covan-ai/covan-api`   | `worker/src/node.ts` — the same code as the Worker |
| `covan-web` | `ghcr.io/covan-ai/covan-web`   | The Vite build served by nitro's node server       |

The Supabase services are trimmed from the [official self-host
bundle](https://github.com/supabase/supabase/tree/master/docker), with the
version pins and inter-service wiring left as upstream had them. Every image is
pinned to an exact tag: self-hosted Supabase moves quickly, and a floating
`:latest` is how a working stack becomes an unreproducible bug report.

Dropped, because nothing in Covan uses them: Studio, Storage, imgproxy,
pg-meta, Edge Functions, Analytics (Logflare), Vector and Supavisor. Uploaded
documents do **not** go to Supabase Storage — they go to the document store
described below. Realtime is kept: the brainstorm board and shared chat
sessions subscribe to `postgres_changes`, and without it both stop updating
live.

## Configuration

Everything lives in `.env`, copied from `.env.docker.example`. The defaults
work as-is on a laptop.

- `OPENAI_API_KEY` — the one value you must supply.
- `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY` — the standard Supabase
  self-host demo keys. They are published, so they are safe for a local stack
  and **unsafe for anything reachable from a network**. Regenerate all three
  ([instructions](https://supabase.com/docs/guides/self-hosting/docker#generate-api-keys))
  before exposing the stack.
- `POSTGRES_PASSWORD`, `SECRET_KEY_BASE`, `ROUTINE_SECRET_KEY` — same story.
  `ROUTINE_SECRET_KEY` must decode to 16, 24 or 32 bytes; it is an AES-GCM key,
  and a wrong length fails when a delivery channel is saved rather than at
  boot.
- `SUPABASE_PUBLIC_URL`, `VITE_API_URL` — addresses the **browser** calls, not
  the API container. Changing them takes effect on
  `docker compose up -d covan-web`; no rebuild.

  Vite does inline `VITE_*` into the JavaScript the browser downloads, which is
  why these used to need a rebuild — and why there was no image worth
  publishing, since the bundle carried whoever built it's configuration. The
  image is now built against placeholder values and
  `scripts/web-runtime-config.mjs` substitutes the real ones in when the
  container starts. One image, any deployment. A missing value stops the
  container with a message rather than serving a frontend that cannot reach
  anything.

Note the asymmetry, which is the most common way this stack gets
misconfigured: `covan-api` reaches Supabase over the compose network at
`http://kong:8000`, while the browser reaches it at `http://localhost:8000`.
Using the service name in the frontend build produces an app that cannot sign
anyone in.

`.env` is gitignored. Keep it that way.

### Every variable, in full

The four notes above are the ones that bite. This is the complete reference —
every line in `.env.docker.example`, in the order it appears there.

| Variable                                               | Default in the template    | What it does                                                                                                                     |
| ------------------------------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                                       | _empty — you must set it_  | Chat completions and `text-embedding-3-small`. Nothing else needs an account.                                                    |
| `OPENAI_BASE_URL`                                      | _empty — means OpenAI_     | Optional. Sends completions to an OpenAI-compatible endpoint instead. See below — it does not move everything.                   |
| `OPENAI_MODEL`                                         | _empty_                    | Optional. Forces one model for every completion, overriding the per-agent picker. Needed whenever `OPENAI_BASE_URL` is set.      |
| `POSTGRES_PASSWORD`                                    | `covan-local-dev-password` | The database password. `auth`, `rest`, `realtime` and `migrate` all connect with it.                                             |
| `POSTGRES_PORT`                                        | `54322`                    | **Host** port only, for `psql` or a GUI client. Inside the compose network Postgres is always on 5432.                           |
| `JWT_SECRET`                                           | Supabase demo secret       | Signs and verifies every access token. Changing it invalidates `ANON_KEY` and `SERVICE_ROLE_KEY`, which are JWTs signed with it. Also passed to the API as `SUPABASE_JWT_SECRET`, which is what makes API keys work — see [The API](api.md). |
| `ANON_KEY`                                             | Supabase demo key          | The public API key. It reaches the browser by design; row level security is what protects the data behind it.                    |
| `SERVICE_ROLE_KEY`                                     | Supabase demo key          | Bypasses row level security entirely. Server-side only — it must never reach a browser.                                          |
| `JWT_EXPIRY`                                           | `3600`                     | Access-token lifetime in seconds. Refresh is automatic in the client.                                                            |
| `SECRET_KEY_BASE`                                      | local placeholder          | Realtime's Phoenix session/cookie signing base. `openssl rand -base64 48`.                                                       |
| `REALTIME_DB_ENC_KEY`                                  | `supabaserealtime`         | Realtime's own column encryption key. Upstream's default; regenerate for anything networked.                                     |
| `ROUTINE_SECRET_KEY`                                   | local placeholder          | AES-GCM key for `delivery_channels.secret_ciphertext`. Must decode to 16, 24 or 32 bytes, or saving a delivery channel fails.    |
| `SUPABASE_PUBLIC_URL`                                  | `http://localhost:8000`    | Where the **browser** reaches Supabase. Applied when `covan-web` starts; no rebuild.                                             |
| `VITE_API_URL`                                         | `http://localhost:8787`    | Where the **browser** reaches the Covan API. Same — restart, not rebuild.                                                        |
| `SITE_URL`                                             | `http://localhost:3000`    | The origin GoTrue puts in confirmation and password-reset links.                                                                 |
| `ALLOWED_ORIGIN`                                       | `http://localhost:3000`    | Comma-separated **exact** origins the API accepts credentialed requests from. Also feeds the routine SSRF guard. No wildcards.   |
| `KONG_HTTP_PORT` / `COVAN_API_PORT` / `COVAN_WEB_PORT` | `8000` / `8787` / `3000`   | Host ports. Change them if something already owns those, and update the `VITE_` URLs to match.                                   |
| `ROUTINE_TICK_MS`                                      | `60000`                    | How often the Node entry point asks whether any routine is due. Per-routine frequency lives in the database, not here.           |
| `RESEND_API_KEY` / `RESEND_FROM`                       | _empty_                    | Optional. Email for routine deliveries and team invitations, via [Resend](https://resend.com). Blank means neither is sent.      |
| `VITE_TERMS_URL` / `VITE_PRIVACY_URL`                  | _empty_                    | Optional. Where the sign-up form's two links point. Blank uses the built-in `/terms` and `/privacy`. See below.                  |
| `COVAN_VERSION`                                        | `latest`                   | Which published image tag to run. `latest` follows releases; `edge` follows `main`; a semver like `0.1.0` pins one.              |

Three more values the API reads are set by `docker-compose.yml` rather than by
you: `SUPABASE_URL` (`http://kong:8000` — the compose network address, not
localhost), `DOCS_DIR` (`/data/docs`, the document volume) and `PORT` (`8787`
inside the container, mapped to `COVAN_API_PORT` outside).

One optional variable is deliberately absent from both: `ADMIN_API_KEY`, which
gates the `POST /admin/backfill-embeddings` maintenance endpoint — the one that
re-indexes documents stored while embedding was failing. Unset, the endpoint
fails closed, which is the right default. Note that adding it to `.env` alone
does nothing: the Compose stack passes an explicit list of variables to
`covan-api`, and this is not on it. To use the endpoint on the Docker stack, add
`ADMIN_API_KEY: ${ADMIN_API_KEY:-}` to that service's `environment:` block
first.

### Using a model that is not OpenAI's

Out of the box Covan talks to `api.openai.com`. Set `OPENAI_BASE_URL` and the
completions go somewhere else instead — Ollama, vLLM, LiteLLM, OpenRouter, or
anything else speaking the OpenAI chat API:

```bash
# in .env, for the Docker stack
OPENAI_BASE_URL=http://host.docker.internal:11434/v1
OPENAI_MODEL=llama3.3:70b
OPENAI_API_KEY=ignored-by-ollama-but-still-required
```

Set both. The model list Covan ships is a list of OpenAI's names, so with only
the base URL set every agent would ask your endpoint for `gpt-4o` and get a
404. `OPENAI_MODEL` overrides that list outright, per-agent picker included —
which means the model dropdown in agent settings has no effect while it is set.
It still shows OpenAI's models; ignore it.

`OPENAI_API_KEY` stays required either way. Most local servers ignore the value,
so any non-empty string works there.

**Two things this does not move, and you should know before you rely on it:**

- **Embeddings.** Every document you upload is still embedded by OpenAI's
  `text-embedding-3-small`. This is not an oversight: `knowledge_chunks.embedding`
  is declared `vector(1536)` and both retrieval functions take that width, so an
  endpoint serving a 768-dimension model would not fail at the request — it
  would fail at the insert, after the upload appeared to succeed. Changing it is
  a migration and a re-index of everything already stored, not a variable.
- **Audio transcription.** Voice notes go to OpenAI too. Most
  OpenAI-compatible servers do not implement `/audio/transcriptions`, so routing
  it there would trade a working feature for a 404.

So `OPENAI_BASE_URL` keeps your conversations off OpenAI. It does not yet keep
your documents off OpenAI. If that distinction matters for your deployment —
and for some teams it is the whole question — the honest answer today is that
Covan is not there yet.

## Terms and privacy

The sign-up form asks people to agree to Terms and a Privacy Policy, so both
have to lead somewhere. Unset, they lead to `/terms` and `/privacy` in the app:
the AGPL and its warranty disclaimer, and a factual account of what the software
stores and every outside service it calls. For a Covan you run for your own
team, that is accurate and sufficient — the licence really is the agreement, and
you are the one holding the database.

If you operate Covan as a service for other people, it is not sufficient, and no
default this repository could ship would be. Point `VITE_TERMS_URL` and
`VITE_PRIVACY_URL` at documents written for your service, and the built-in pages
stop being linked. Like the other `VITE_` values they are applied when the
container starts, so `docker compose up -d covan-web` is enough.

## Uploaded documents

`covan-api` has no Cloudflare R2 binding, so `getDocStore()` falls back to the
filesystem store rooted at `DOCS_DIR=/data/docs`, which is the `covan-docs`
named volume. Each document is one file plus a `.meta.json` sidecar holding its
content type.

- **Ownership.** The API container runs as the unprivileged `bun` user
  (uid/gid 1000), and `Dockerfile.api` creates `/data/docs` owned by it. Docker
  seeds a fresh named volume with the ownership of the image directory it
  covers, so the volume comes up writable. If you replace the volume with a
  bind mount — `- ./my-docs:/data/docs` — the host directory keeps its own
  ownership and you must `chown 1000:1000` it yourself, or every upload fails.
  A permissions failure surfaces as a real error from the API rather than a
  silent "document not found", which is what you want when a mount is wrong.
- **Symlinks.** The store rejects keys that resolve outside its root, but the
  check is lexical rather than `realpath`-based, so a symlink _already inside_
  the store that points elsewhere would be followed. Exploiting that requires
  the ability to write into the volume already. Do not share the document
  volume with untrusted processes.
- **Backups.** `docker run --rm -v covan_covan-docs:/d -v "$PWD":/out alpine
tar czf /out/covan-docs.tgz -C /d .` and the equivalent `pg_dump` for the
  database.

## Migrations

The `migrate` service applies `supabase/migrations/*.sql` in filename order and
exits. It keeps a ledger in `covan_meta.migrations`, so bringing the stack up
again is a no-op and adding a migration later applies only the new file. This
is not decoration: the migrations are not idempotent — `0001_init.sql` starts
with a bare `create table public.profiles` — so a runner without a ledger fails
on the second `docker compose up`.

`migrate` waits for both `db` and `auth` to be healthy. `0001_init.sql`
references `auth.users`, and that table does not exist until GoTrue has run its
own migrations.

The directories it reads come from `MIGRATION_DIRS`, a space-separated list
applied left to right, with missing entries skipped. It defaults to the mount
points the compose file provides, so there is nothing to set for a normal
`docker compose up`. It is there so the same script can also run against a
database that is not the compose one — a managed Postgres, say — without a
second copy of the ledger logic drifting out of step with this one:

```bash
POSTGRES_HOST=db.example.com POSTGRES_PORT=5432 POSTGRES_DB=postgres \
POSTGRES_PASSWORD=... MIGRATION_DIRS="supabase/migrations" \
sh docker/migrate.sh
```

Filenames have to stay unique across whatever directories you list: the ledger
keys on the filename alone, so a duplicate would be silently skipped. The script
refuses to start rather than let that happen.

To inspect the database:

```bash
docker compose exec db psql -U postgres
```

## Runtime versions

- The API image runs **Bun** (`oven/bun:1.3.0-alpine`), matching
  `bun run start:node`.
- The web image runs **Node 22**, not Node 20. `@supabase/supabase-js` builds a
  realtime client inside `createClient()`, and that constructor throws
  `Node.js detected but native WebSocket not found` on anything below Node 22 —
  a global `WebSocket` only arrived in Node 22. `src/lib/supabase/client.ts` is
  imported during server-side rendering, so on Node 20 every page renders the
  error shell. The build is green either way; the failure is purely at runtime.

## Alternative: the Supabase CLI

`supabase/config.toml` configures the same schema for `supabase start`, which
gives you Studio and mail catching on ports 54321-54327. It is a different way
to run the backing services, not a different product — and it cannot run at the
same time as this stack, since both want port 54322 for Postgres.

## Deploying somewhere other than your laptop

Before the stack faces a network:

1. Regenerate `JWT_SECRET` and both API keys, `POSTGRES_PASSWORD`,
   `SECRET_KEY_BASE` and `ROUTINE_SECRET_KEY`.
2. Turn `GOTRUE_MAILER_AUTOCONFIRM` off and configure `GOTRUE_SMTP_*`, or
   anyone can register any address.
3. Put TLS in front of ports 3000, 8787 and 8000, and set
   `SUPABASE_PUBLIC_URL`, `VITE_API_URL`, `SITE_URL` and `ALLOWED_ORIGIN` to
   the public URLs — then rebuild `covan-web`.
4. Rate-limit the API at that same proxy, as well as the built-in limiter. See below.
5. Consider not publishing `54322` at all.

Every port `docker-compose.yml` publishes now binds to `127.0.0.1` by
default, controlled by `BIND_ADDR` in `.env`. That default is doing real
work: Docker publishes ports through `nat/PREROUTING`, which runs before
your firewall's `INPUT` chain, so `ufw default deny incoming` does not
touch a published port — the bind address is the only thing standing
between the compose network and the internet until you've done the rest of
this list. Setting `BIND_ADDR=0.0.0.0` (or any non-loopback address) to
expose the stack is a deliberate choice, and it should never be made
without regenerating the secrets in step 1 first — those are demo values
published in this repository, not a guess an attacker has to make.

`covan-api` now enforces part of step 1 itself: at boot, if `ALLOWED_ORIGIN`
is not a localhost URL, it refuses to start when `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` or `ROUTINE_SECRET_KEY` still hold the exact
values `.env.docker.example` ships, naming every offending variable in the
error. It also refuses to start on any `ROUTINE_SECRET_KEY` that does not
decode to 16, 24 or 32 bytes, so a bad key is caught at boot instead of the
first time a delivery channel is saved.

`loadEnv` cannot see `JWT_SECRET` and `POSTGRES_PASSWORD` — they are consumed
by Kong, GoTrue, PostgREST and Postgres, none of which run it — so
`docker-compose.yml` carries a second, independent guard for the rest of
step 1: a `secrets-check` service that runs `docker/check-secrets.sh` and
that `db` depends on with `condition: service_completed_successfully`. Every
other service descends from `db`, so this one check gates the whole stack.
Its logic mirrors `loadEnv`'s — same localhost carve-out, same "still holds
the published default" test — but over `JWT_SECRET`, `POSTGRES_PASSWORD`,
`SECRET_KEY_BASE`, `ANON_KEY`, `SERVICE_ROLE_KEY` and `ROUTINE_SECRET_KEY`,
naming every offending variable the same way. Regenerating
`SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` while leaving
`JWT_SECRET` at its published default still achieves nothing, and both
checks will say so: those two keys are JWTs signed with `JWT_SECRET`, and
anyone who has read this repository already knows that secret and can mint
their own `{"role":"service_role"}` token, bypassing row level security the
same way the shipped key would have. Regenerate `JWT_SECRET` first, then the
two keys it signs.

### Covan rate-limits itself, and you should still limit at the proxy

Two tiers, on by default, on both deployment paths. They exist because
`POST /chat/stream`, `POST /transcribe` and four other endpoints spend money at
OpenAI on every call, so an authenticated user with a loop — or one leaked
password — is an unbounded bill rather than a denial of service. Request _size_
was always bounded (10 MB for a document, 2 MB for audio); that caps what one
call costs, not how many arrive.

| Tier        | In front of                                                                                                            | Keyed on             | Default |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------- | ------- |
| `standard`  | everything, including the token check                                                                                  | the caller's address | 120/min |
| `expensive` | `/chat/stream`, `/transcribe`, `/brainstorm/ideas/suggest`, `/persona/suggest`, `/routines/draft`, `/routines/:id/run` | the signed-in user   | 20/min  |

`standard` is generous on purpose: it is keyed by address, a shared office is
one address, and its job is to bound how often the Supabase round trip in the
token check can be provoked — not to ration ordinary use. `expensive` is keyed
by the user, so one person's loop cannot spend a colleague's allowance, and it
is set at more than a person can type and far less than a loop can.

Document upload and reindex stay on `standard` deliberately. They spend on
embeddings, which cost roughly a hundredth of what a chat token does, and 20/min
would break bulk upload to bound a cost the generous tier already bounds.

A refused request gets `429` and a `Retry-After` header.

**Under `docker compose`** the counter lives in the API process. Set
`RATE_LIMIT_STANDARD_PER_MINUTE` and `RATE_LIMIT_EXPENSIVE_PER_MINUTE` to change
the numbers, or either to `0` to turn that tier off. Two honest limitations:

- **One process, one counter.** Run two replicas and each keeps its own, so the
  effective limit is the configured one times the number of replicas. If you are
  running replicas you have a proxy in front of them; set the real limit there
  and these to `0`.
- **A fixed window, not a sliding one.** A caller can spend the whole allowance
  in the last second of one window and again in the first second of the next.
  That is a factor of two on a limit whose job is to turn unbounded into bounded.

**On Cloudflare Workers** the counter lives in the edge, via the two
`[[ratelimits]]` blocks in `worker/wrangler.toml` — the limit is set there
rather than in an environment variable, because the binding owns the counter.
Deploy without them and the Worker falls back to the in-process counter, which
on Cloudflare is close to no limit at all: isolates are many and short-lived, so
each keeps its own. It logs an error saying exactly that, but it will not refuse
to start, so check `wrangler.toml` against the example rather than the logs.

**Limit at your proxy as well.** Nothing above sees a request that never reaches
the API, and everything above runs after TLS termination and inside your
application. A limiter in the layer you already have is cheaper per refused
request and protects against shapes this one cannot see:

| Deployment                                       | Where the second limiter goes                                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose`, behind nginx / Caddy / Traefik | The reverse proxy from step 3. nginx's `limit_req`, Caddy's `rate_limit`, Traefik's `RateLimit` middleware — any of them, keyed on client IP. |
| Cloudflare Workers                               | A [Rate Limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) on the zone, in front of the Worker.                       |

If you do, set the built-in tiers to `0` rather than running two limiters that
disagree about who is over.

## The production path: Cloudflare, Supabase and a static host

The other way to run Covan is with managed pieces: Supabase for the database and
auth, the API as a Cloudflare Worker with an R2 bucket, and the frontend on any
host that can build a Vite app. It is the same source — the
seams described in [`architecture.md`](architecture.md#the-two-seams) are what
make that true — but it is several accounts of setup instead of one command. Use
the Docker stack unless you specifically want managed pieces.

Everything below assumes you are at the repository root and have run
`bun install` in both the root and `worker/`.

### 1. Create the Supabase project

Create a project at [supabase.com](https://supabase.com), then collect three
values from its API settings: the project URL, the `anon` key, and the
`service_role` key.

### 2. Apply the migrations

`supabase/migrations/` is the schema, numbered and applied in filename order.
With the [Supabase CLI](https://supabase.com/docs/guides/cli) linked to your
project:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

If you would rather not link the CLI to a production project, the migrations are
plain SQL: open the SQL editor and run `0001_init.sql` through the last file, in
order, one at a time. Do not skip one and do not reorder them — `0001_init.sql`
starts with a bare `create table`, and later files alter what earlier ones
create.

> Honest note: the numbered migrations in this repository are applied end to end
> on every fresh `docker compose up`, and have been applied by hand to a hosted
> project. The two CLI commands above are the documented Supabase equivalent and
> were _not_ re-run against a hosted project while writing this guide — check the
> [CLI docs](https://supabase.com/docs/guides/deployment/database-migrations) if
> `db push` reports drift.

### 3. Configure and deploy the API Worker

Steps 3 and 4 all run from `worker/`.

```bash
cd worker
cp wrangler.toml.example wrangler.toml
```

Then edit `wrangler.toml`: set `account_id` to your Cloudflare account id, and
set `ALLOWED_ORIGIN` to the exact origin your frontend will be served from. The
real `wrangler.toml` is gitignored precisely because it carries an account id —
commit the `.example`, never the file.

Create the bucket named in the config, then set the seven secrets:

```bash
bunx wrangler r2 bucket create covan-docs

bunx wrangler secret put SUPABASE_URL
bunx wrangler secret put SUPABASE_ANON_KEY
bunx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
bunx wrangler secret put OPENAI_API_KEY
bunx wrangler secret put ROUTINE_SECRET_KEY
bunx wrangler secret put RESEND_API_KEY
bunx wrangler secret put RESEND_FROM
bunx wrangler secret put SUPABASE_JWT_SECRET
```

`ROUTINE_SECRET_KEY` must decode to 16, 24 or 32 bytes — `openssl rand -base64
32`. The two `RESEND_*` values cover the two things Covan emails: routine
deliveries to an email channel, and the note that tells somebody they have been
invited. Skip both and neither goes out — routines can still deliver to Slack,
and an invitation is still created and still works, but you have to tell the
person yourself. Set one without the other and the two paths differ: an
invitation checks for both and quietly reports that nothing was emailed, while a
routine posts anyway and records whatever Resend answers as a failed run. So if
you set one, set both.

`SUPABASE_JWT_SECRET` is the project's JWT signing secret — Supabase dashboard,
Settings → API — and it is what turns on [API keys](api.md). A key carries no
identity of its own, so the API exchanges it for a sixty-second token belonging
to the key's owner, and signing that needs this secret. Leave it out and the
feature is simply absent: the section does not appear in Settings and the
endpoints answer `available: false`, rather than anything failing. On a compose
stack there is nothing to do — `docker-compose.yml` already passes the
`JWT_SECRET` the rest of the stack uses.

Pointing this deployment at a non-OpenAI endpoint works the same way as it does
under Docker, except that neither value is a secret — add them to the `[vars]`
block in `wrangler.toml` beside `ALLOWED_ORIGIN`:

```toml
OPENAI_BASE_URL = "https://openrouter.ai/api/v1"
OPENAI_MODEL = "meta-llama/llama-3.3-70b-instruct"
```

The same two exceptions apply — embeddings and transcription still go to
OpenAI. Set them on the routine engine too, or scheduled work will keep using
OpenAI while chat does not.

Check the build, then ship it:

```bash
bun run dry      # wrangler deploy --dry-run — prints the bindings it resolved
bun run deploy
```

`bun run dry` is worth the extra ten seconds: it prints the bucket and vars the
Worker will actually get, which is where a mistyped binding shows up.

Confirm it is alive — `/health` is the only unauthenticated route:

```bash
curl https://<your-worker>.workers.dev/health      # -> {"ok":true}
```

### 4. Deploy the routine engine

Routines need something to wake them up. On Cloudflare that is a cron trigger,
and it lives in a second Worker (`src/cron.ts`) with no HTTP surface at all:

```bash
cp wrangler.cron.toml.example wrangler.cron.toml
# set account_id and ALLOWED_ORIGIN to match wrangler.toml
bun run dry:cron
bun run deploy:cron
```

Set its secrets the same way, adding `-c wrangler.cron.toml` to each
`wrangler secret put`. It needs six: `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `ROUTINE_SECRET_KEY`,
`RESEND_API_KEY` and `RESEND_FROM`. It gets no anon key and no bucket, because
it never acts on behalf of a user and never touches a document.

**`ROUTINE_SECRET_KEY` must be byte-identical to the API Worker's.** The API
encrypts every delivery destination with it and this Worker decrypts them. A
different value here does not fail loudly — it makes every configured Slack
webhook and email address undecryptable.

Watch a tick with `bun run tail:cron`.

If your account has a free cron slot you can skip this Worker entirely and add a
`[triggers]` block to `wrangler.toml` instead; `src/index.ts` already exports
`scheduled`. Running both at once is also safe — see the first trap below.

### 5. Deploy the frontend

Three build-time variables, because Vite inlines them into the JavaScript the
browser downloads:

```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
VITE_API_URL=https://<your-worker>.workers.dev
```

The anon key is the only key that may appear here. It is public by design, and
row level security is what protects the data behind it. Never put the
service-role key in a `VITE_*` variable.

On Vercel or Netlify, set those three in the project's environment and let the
provider build; nitro auto-detects the target, so leave `NITRO_PRESET` unset.
For a plain Node host:

```bash
NITRO_PRESET=node-server bun run build
node .output/server/index.mjs        # honours PORT and HOST
```

That host needs **Node 22 or newer**. See [Runtime versions](#runtime-versions)
above for why; the symptom on Node 20 is that every page returns an error shell
from a build that reported success.

### 6. Close the loop

Set `ALLOWED_ORIGIN` in both wrangler configs to the frontend's real origin and
redeploy both Workers. Then sign up on the deployed frontend: if sign-up works
but every API call fails in the browser with a CORS error, this is the variable
that is wrong.

## Two traps worth knowing about

**The Workers Free plan caps an account at five cron triggers.** Registering a
sixth does not fail cleanly. The deploy uploads the script _first_ and registers
schedules _second_, so you get a half-succeeded deploy: new code live, no
trigger, and an error message about schedules that reads like the whole thing
failed. This is why `wrangler.toml.example` ships with no `[triggers]` block and
the engine has its own config — a second Worker, and if necessary a second
account, keeps the API's deploy path clear of the cap.

Running the engine in two places at once is safe, which is what makes that split
cheap: `claim_due_routines` hands out rows with `for update skip locked`, so two
ticks can never claim the same routine.

**`ALLOWED_ORIGIN` must list exact origins — never a `*.vercel.app` pattern.**
This looks like unnecessary friction until you see why. Vercel serves
project-name subdomains first-come on a shared apex, so a regex that matches
`*.vercel.app`, or even one anchored to your own project slug, can be satisfied
by someone who names _their_ project to embed that slug —
`your-project-evil-team.vercel.app`. Combined with `credentials: true`, that is a
real cross-origin read of your users' data. The API therefore reflects only
exact strings from `ALLOWED_ORIGIN` (plus `localhost` in code, for development).
Add each preview host you actually use, by name.

The same variable feeds the routine engine's SSRF guard, which uses it to refuse
routines pointed back at your own deployment. Keep the two configs in sync.

## Troubleshooting

**`Missing required environment variables: ...`** — `covan-api` says exactly
which ones. Set them in `.env` and `docker compose up -d covan-api` again.

**The database is stuck or half-initialised.** The init hooks in
`docker/db-init/` run only when the data volume is empty, and the image's
entrypoint aborts the whole sequence on the first error. Start clean:
`docker compose down -v && docker compose up`.

**Port already in use.** Change `COVAN_WEB_PORT`, `COVAN_API_PORT`,
`KONG_HTTP_PORT` or `POSTGRES_PORT` in `.env`. If you change the first three,
rebuild `covan-web` so the frontend points at the new ports.

**Chat answers fail but everything else works.** That is the OpenAI key —
check `docker compose logs covan-api`.
