# The agent-turn eval

Every lever left in the token-cost work changes what the model reads — a
smaller tool-output cap, a tighter history budget, a cheaper model, context
editing. Until now the only thing standing between those and a worse product
was a request-shape assertion: the tests check what goes on the wire, and
nothing checks what comes back. `ci.yml` says so in as many words — *"No test
makes a model call."* That is still true of CI, and this is the thing that runs
outside it.

## What it measures

One flow: **a tool-using agent turn**, entered through `runAgentTurn` — the
same function `routes/chat.ts` and `lib/routines/agent-run.ts` both go through.
Eighteen cases, each a rewrite of a real production turn, graded by a blind
pairwise judge against a frozen set of today's answers.

Pairwise rather than a score out of five, because the question every change
here asks is comparative: *did this get worse?* Judges are more consistent
picking between two answers than placing one on an absolute scale, and the
difference of two noisy absolutes is noisier than a direct comparison. Ties are
allowed and expected — a change that is supposed to be output-neutral should
produce them, and forcing a winner would manufacture a signal from two answers
that are the same.

## What it cannot measure

Worth reading before trusting a number out of it.

- **The cases are synthetic.** Same shape as the real turns — step count, tool
  order, result sizes, what made each one hard — with the content rewritten.
  `covan-ai/covan` is public and the real turns carry a customer list, a named
  colleague and an unpublished strategy note. So this can tell you whether the
  model writes a good answer from passages of that size and quality; it cannot
  tell you whether retrieval is finding the right passages in *your* documents.
- **The tools do not run.** They replay canned output, which is what makes two
  runs comparable: if retrieval returned different passages each time, the
  difference between two answers would say nothing about the change under test.
  It also means `send_email` and `schedule_job` have no side effect here, which
  is not optional for a script anybody can run.
- **It is not a retrieval eval, a latency eval or a cost eval.** Latency and
  cost are recorded per case and shown beside the score, but they are
  side-channels: the runner holds tool output fixed, so its latency is not
  production's.
- **Resolution.** Eighteen cases at one rep resolves a win-rate difference of
  roughly ±24 points (`1/sqrt(n·reps)`); at three reps, about ±14. A change
  that loses half the cases will be obvious. A two-point regression will not
  be visible at any rep count this set can afford — if that is what you need to
  see, the answer is more cases, not more reps. Calibration has since measured
  this rather than estimating it; see below.

## What calibration measured (2026-09-25)

`calibrate.ts`, six cases, `claude-sonnet-5` under an `claude-opus-5` judge,
$0.469.

**Separation 6/6.** Every hand-spoiled answer lost to the real one, and the
reasoning named the defect rather than gesturing at quality: the arithmetic
(54,000 where the tier discount makes it 48,600), the invented figure (`214
shipments, 1.4%` with no database reached), the leaked source filename. The
judge can tell a bad answer from a good one, which was the question it existed
to answer.

**Tie rate 2/6.** Two samples of the *same unchanged system* were judged
different four times out of six. Read the four and none of them is the judge
inventing a preference — each rests on something checkable:

| case | what actually differed |
|---|---|
| `doc-absent-capability` | one sample offered Slack as a notification channel; there is no such tool |
| `db-usage-by-customer` | one sample wrote "nearly 1.7x" where 4,812/3,140 is 1.53 |
| `budget-exhausted` | one claimed no database was reachable without ever calling `describe_connection` |
| `db-always-failing` | **2 steps against 8** — one sample repeated the same search eight times |

So the noise is in the system under test, not in the judge. The same question,
at the same settings, can take two steps or eight.

**The splits went 2–2 between the two sides.** That matters more than the rate
does. A judge that invents preferences with a bias cannot be rescued by
repetition; one whose noise is symmetric can, because symmetric noise averages
out. This one is symmetric.

**What follows.** Per comparison the outcome is +1/0/−1 at roughly a third
each, so the standard error over eighteen comparisons is about 19 points —
close to the ±24 the arithmetic above predicted, which turns that estimate into
a measurement. This set is therefore a **regression tripwire, not a quality
meter**: it reliably catches an invented number, a wrong calculation, or a
retry loop that eats the budget, and it cannot see a small change at all.
That is the right instrument for what remains — the risk in cutting a budget
or swapping a model is a turn that stops half-done or starts fabricating, not
an answer three points worse. Claiming more of it than that would be reporting
a measurement nobody took.

## Running it

The key comes from the environment or from `worker/.dev.vars`, which is where
this repository already keeps local secrets and is gitignored. Add a line to it
once and every command below works:

```
ANTHROPIC_API_KEY=sk-ant-...
```

```sh
cd worker

# Check the judge before trusting it. ~$0.40.
bun eval/calibrate.ts

# Freeze today's answers. Do this once, before the change you want to judge.
bun eval/run.ts --variant baseline

# Then, after the change:
bun eval/run.ts --variant v1 --judge
```

`--dry` prints what a run would do and stops without spending. `--only <prefix>`
runs a subset by case-id prefix. `EVAL_REPS`, `EVAL_MODEL`, `EVAL_JUDGE_MODEL`,
`EVAL_CONCURRENCY` and `EVAL_TIMEOUT_MS` override the defaults
(`claude-sonnet-5` under test, `claude-opus-5` judging, 4 in flight).

A run is resumable: results are written as each case lands and a restart skips
exactly the `(case, rep)` pairs already on disk.

### What it costs

About **$1.00** for a baseline pass and **$1.35** for a judged variant pass, at
list price on `claude-sonnet-5` with an `claude-opus-5` judge. Three reps of
both is under $8. The script prints its own measured spend at the end; the
figure above is the estimate, not the bill.

## The frozen reference

`--variant baseline` writes `.claude/hillclimb/agent-turn/baseline/ref/<id>.txt`
and every later run is judged against those files. **They are committed on
purpose.** A win rate only means something against a fixed opponent —
regenerate the reference and "60% wins" silently changes what it is 60% of. So
the reference is a reviewed fixture, not run output, and the rest of
`.claude/hillclimb/` is gitignored.

When a variant eventually saturates against it — nearly every case a win, the
metric stopping discriminating — freeze that variant's answers as a *second*
reference and carry both columns. Do not replace the first.

## The case set

`cases.ts`, and the sign-off on it matters more than anything else here: a
number from cases nobody agreed were representative is a number nobody acts on.

| id | lead tag | steps | what it is for |
|---|---|---|---|
| `doc-single-hit` | search_documents | 1 | one search is enough; does it stop |
| `doc-what-is-it` | search_documents | 2 | plain grounded answer from two hits |
| `doc-named-file` | search_documents | 3 | a miss between two hits; does it still answer |
| `doc-absent-capability` | search_documents | 2 | nothing found; does it say so |
| `doc-conflict` | search_documents | 2 | two passages disagree; does it notice |
| `doc-runaway` | search_documents | 8 | the real turn that searched eight times, five empty |
| `db-usage-by-customer` | query_database | 4 | schema first, then the aggregate |
| `db-error-recovery` | query_database | 5 | first query errors; does it look instead of guess |
| `db-segmentation` | query_database | 6 | nine rows into three named groups |
| `db-trimmed-result` | query_database | 3 | result past the 8,000-char cap; does it notice |
| `db-always-failing` | query_database | 3 | the connection is down; does it invent a number |
| `ctx-continue` | query_database | 4 | "tamam devam et" — only the history says what that means |
| `long-history` | query_database | 2 | eight prior turns; does it use them and not repeat them |
| `schedule-job` | schedule_job | 1 | the one tool that proposes rather than reads |
| `no-tool-arithmetic` | no-tool | 0 | both numbers are already in the conversation |
| `no-tool-from-rag` | no-tool | 0 | the retrieved block already answers it |
| `out-of-scope` | no-tool | 0 | no tool could reach it; does it refuse cleanly |
| `budget-exhausted` | budget | 8 | spends the whole budget and must still answer |

The last one earns its place twice over: the budgeted final pass is the one
place Phase 1 could have changed behaviour, and an empty answer there is the
exact failure its fallback exists to prevent. `run.ts` records an empty answer
as its own failure class rather than as a zero.
