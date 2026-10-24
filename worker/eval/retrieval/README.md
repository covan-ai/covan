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
- no category loses more than **one case** at R@5 (`compare.ts` flags `DROP`);
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

2026-10-24, `main` at `8e6581b` plus this benchmark, `text-embedding-3-small`,
default `RAG_MIN_SIMILARITY` and `RAG_LEXICAL`, 173 passages, 62 cases
(`results/baseline.json`).

| category       | cases | R@5   | R@10  | MRR   | pass  |
| -------------- | ----- | ----- | ----- | ----- | ----- |
| exact-term     | 8     | 75.0% | 87.5% | 0.556 |       |
| paraphrase     | 7     | 100%  | 100%  | 0.571 |       |
| morphology     | 8     | 62.5% | 75.0% | 0.580 |       |
| cross-language | 8     | 12.5% | 12.5% | 0.063 |       |
| table          | 7     | 57.1% | 71.4% | 0.192 |       |
| follow-up      | 7     | 42.9% | 57.1% | 0.342 |       |
| versions       | 8     | 87.5% | 87.5% | 0.813 |       |
| negative       | 9     |       |       |       | 44.4% |
| **overall**    |       | 62.3% | 69.8% | 0.449 | 44.4% |

By language: Turkish R@5 59.4% / MRR 0.468, English 66.7% / 0.421.
Retrieval p50 214 ms, p95 254 ms. Negative cases still put ~3,900 characters
in front of the model on average.

### Noise floor

The same baseline run twice (`compare.ts baseline baseline-rerun`): overall
R@5 moved 0.019 and overall MRR 0.001 — one case of 53. Within a category the
largest moves were R@5 0.125 (morphology, one case of eight) and MRR 0.095
(follow-up). **With seven or eight cases a category, one case flipping is
0.125–0.143.** The per-category clause was first written as "R@5 falls by no
more than 0.05", which one case of noise already breaks; it was changed to
"loses no more than one case" on 2026-10-24, after this rerun and before any
variant was compared. The overall thresholds are well above the noise.

## Results

### Reranking (`RAG_RERANK_MODEL`, 2026-10-24) — kept, `gpt-4.1-mini`

The search hands 30 candidates to a model that scores each 0–3 for whether it
answers the question (`lib/rerank.ts`); the ten best scored 1+ go on.

| run                          | R@5   | R@10  | MRR   | negative pass | p95 ms | rerank tokens / search |
| ---------------------------- | ----- | ----- | ----- | ------------- | ------ | ---------------------- |
| baseline                     | 62.3% | 69.8% | 0.449 | 44.4%         | 254    | —                      |
| gpt-4.1-mini                 | 81.1% | 81.1% | 0.701 | 44.4%         | 1187   | ~7,100 in, ~13 out     |
| gpt-4.1-mini, chips by score | 81.1% | 81.1% | 0.681 | 66.7%         | 1379   | ~7,100 in, ~13 out     |
| gpt-5-mini                   | 83.0% | 83.0% | 0.727 | 55.6%         | 1925   | ~6,800 in, ~25 out     |
| gpt-5-nano                   | 30.2% | 30.2% | 0.211 | 66.7%         | 2086   | ~7,100 in, ~46 out     |

`gpt-4.1-mini` meets every clause of the keep rule: MRR +0.252, cross-language
R@5 12.5% → 75%, morphology 62.5% → 100%, no category lost a case, p95 under
1500 ms. `gpt-5-mini` scores a little higher and fails the latency clause.
`gpt-5-nano` throws most right passages away (scores them 0) and fails nearly
every category.

Citations first stayed on vector similarity, so the passage the reranker put
first — often in the other language, so low on similarity — could go without a
chip while its neighbours got one, and the negative pass rate did not move.
Chips now follow the reranker's score where it read the passage (2 or more:
answers at least in part): the second gpt-4.1-mini row. Same ranking within
noise; negative pass 44% → 67%.

Not fixed: follow-up questions, which depend on what `retrievalQuery` sends
rather than on the order.

The first attempt asked for one score per passage as a list; `gpt-5-nano`
returned a list of the wrong length on 49 of 62 searches. The reply is now
keyed by passage number and lists only the relevant ones.
