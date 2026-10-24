# The retrieval benchmark

Whether the search finds the right passage. `worker/eval/` grades the answer a
model writes from passages it is handed; it says so itself — _"it cannot tell
you whether retrieval is finding the right passages"_. This is the part that
does.

## What it measures

An invented corpus (`corpus/`: a handbook, contracts, notes, a price list, two
versions of one policy, about half Turkish and half English) is indexed into
the repo's own docker stack through the same passage preparation the indexing
job uses (`preparePassages`, `lib/bearings.ts`). Every case in `cases.ts` is
then asked through the real `retrieveForAgent`, with a real user's client, so
the search is the one a chat turn runs, policies and all.

A case is correct when a passage the search ranked contains one of its
markers. Per category and overall:

- **R@5, R@10** — how often the right passage is in the first five or ten.
- **MRR** — the mean of 1/rank of the first right passage (0 when absent).
  Rewards getting it to the top, not just onto the list.
- **Negative pass rate** — for questions the corpus cannot answer, how often
  nothing was cited. The block may still hold weak passages for the model to
  read; `block chars` says how much.
- **p50 / p95 ms** — retrieval wall time, embedding call included.

Categories: `exact-term`, `paraphrase`, `morphology` (Turkish inflection),
`cross-language`, `table`, `follow-up` (a question with no nouns of its own),
`versions` (only the newer policy is right), `negative`.

## How to run it

It makes real embedding calls and needs a database, so it is not in CI.
`cases.static.test.ts` is, and catches a broken case set without either.

From the repo root, in a checkout whose `.env` you do not mind replacing
(a worktree is ideal):

```bash
cp .env.docker.example .env
printf '\nOPENAI_API_KEY=unused-by-the-stack\n' >> .env
docker compose up -d --wait db auth rest kong
docker compose run --rm migrate

set -a && . ./.env && set +a
export SUPABASE_TEST_URL="http://localhost:${KONG_HTTP_PORT:-8000}"
export SUPABASE_TEST_ANON_KEY="$ANON_KEY"
export SUPABASE_TEST_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"

cd worker
bun eval/retrieval/run.ts --label baseline
bun eval/retrieval/compare.ts baseline <another-label>
```

If another Covan stack is already running on this machine, give this one other
ports (`POSTGRES_PORT`, `KONG_HTTP_PORT` in `.env`), other container names (a
`docker-compose.override.yml` setting each service's `container_name`), and its
own project (`docker compose -p covan-bench …`).

The OpenAI key comes from `OPENAI_API_KEY` or `worker/.dev.vars`, as for
`eval/run.ts`. `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `RAG_MIN_SIMILARITY`
and `RAG_LEXICAL` are read from the environment, so a variant can be measured
without editing code. Corpus vectors are cached in `.cache/` (gitignored) under
the model and width, so a rerun embeds only the questions.

Each run creates its own user and workspace and removes them at the end, so
runs do not see each other's passages.

## The keep rule

Written before the first comparison, and not to be moved after one is seen. A
change to retrieval is kept when, against the baseline:

- overall MRR rises by at least **0.02**, and overall R@5 does not fall;
- no category's R@5 falls by more than **0.05** (`compare.ts` flags `DROP`);
- the negative pass rate does not fall;
- p95 retrieval time stays under **1500 ms**.

A delta smaller than the noise floor below is not a result in either direction.

## What it cannot measure

- **The corpus is invented.** It is shaped like a small company's files, and
  it is nobody's. A real team's documents may be longer, messier, or in a
  format the corpus does not have.
- **`match_chunks` only.** A deployment with vectors in Vectorize
  (`PASSAGES`, `0116`) searches through `match_passages_ranked`, which is
  approximate and sees at most 40 vector candidates. Any change to the vector
  arm, the fusion or the candidate counts has to be measured once against a
  non-production Vectorize index as well before it ships.
- **One bundle, one person.** Scope — private bundles, shared replies, the
  service-role paths — is the RLS suite's job (`tests/rls/knowledge-scope`),
  not this one's.
- **Query embeddings are live.** Corpus vectors are cached, the questions'
  are not, so two runs can differ slightly. The noise floor below is how much.

## Baseline

_Not yet recorded._
