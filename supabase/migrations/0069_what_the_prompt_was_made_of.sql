-- What the prompt was made of.
--
-- 0062 added `pass_usage` because a reply's token total could not say which of
-- its model calls spent them. This is the same sentence one level down: a pass's
-- `prompt` count cannot say which PART of the prompt spent them, and by the time
-- anybody asks, the parts have been garbage collected.
--
-- WHAT PROMPTED IT. covan#226 cut a tool turn from $0.5822 to $0.1185 by
-- removing wasted steps, and in doing so inverted the bill: failed steps went
-- from 26% of all steps to zero, and **cache write went from 23% of a turn to
-- 73%**. So the remaining cost is the prefix that gets written on every turn,
-- and the first question about it — what is in there — had no answer in this
-- database. Reconstructing the 2026-09-28 21:41 turn from source accounted for
-- ~15,000 characters against a reported 11,931 prompt tokens, which is 1.25
-- chars per token and not possible for JSON plus prose.
--
-- WHAT THE ANSWER TURNED OUT TO BE, measured on 2026-09-29 against Anthropic's
-- free `POST /v1/messages/count_tokens`, building the request through the real
-- `complete()` so the numbers are of the request the Worker actually sends
-- (`casual agent` on claude-opus-5, its own persona, its six document names, the
-- workspace's four connections, a retrieval block from the real COVAN.md):
--
--   component                              tokens    of 11,791
--   ------------------------------------------------------------
--   web_search server tool                  5,588        47%
--   the app's own 8 tool schemas             2,800        24%
--   retrieval block (4,000 chars)            2,085        18%
--   persona + concision instructions           291         2%
--   connection manifest (4 rows)               273         2%
--   document manifest (6 names)                211         2%
--   CAPABILITIES (web search wording)          123         1%
--   whenAndWhere (date + zone)                 109         1%
--   thinking + output_config                     0         0%
--   floor (model + the question)                25
--   ------------------------------------------------------------
--   counted 11,791 against 11,931 observed — 1.2% apart, which is the fixture.
--
-- Two things in that table were not knowable from the source. **Anthropic's
-- server-side web_search tool costs 5,588 tokens for the 51 characters we send**
-- (`{"type":"web_search_20260209","name":"web_search"}` in `lib/completion.ts`)
-- — a definition and an instruction set injected on the provider's side, charged
-- on every request whether the model searches or not, and paid at the 1.25x
-- write premium on the first pass of every turn. And `thinking` costs nothing,
-- where it had been assumed to cost something.
--
-- So the fixed parts are 71% of this prompt and vary not at all per turn, and
-- what this column records is the rest: the envelope that moves. It is the
-- character side of an equation whose token side the provider reports, and the
-- two together are what let somebody ask "why was this turn 4,000 tokens bigger
-- than that one" a month from now.
--
-- jsonb rather than a table, for 0062's reason verbatim: read by hand in a SQL
-- editor while somebody is asking a question about spend, never by the product,
-- never joined, never filtered. Not added to `workspace_usage*` either — this is
-- not a cost column, and a view that summed characters would invite somebody to
-- price them.
--
-- Shape:
--   {"system_chars":2962,"manifest_chars":533,"doc_names":6,"rag_chars":4000,
--    "history_turns":0,"history_chars":0,"question_chars":37,
--    "tools":["search_documents","find_tool",...],"web_search":true,
--    "mode":"normal"}
--
-- `system_chars` is the length of the WHOLE assembled block rather than a sum of
-- itemised pieces, so a part added to the prefix and not added here leaves the
-- breakdown incomplete and the total exactly right. `prompt.test.ts` asserts
-- that equality. The per-part lengths of persona, CAPABILITIES, the mode block
-- and the document manifest are deliberately absent: they are derivable from
-- (`mode`, `web_search`, `doc_names`) plus constants that live in git. Tool
-- *byte* counts are absent for the same reason — a schema is a property of the
-- build, not of the request — so the names are recorded and the bytes are a
-- `git show`.
--
-- Null, no default, no backfill. Every reply already stored was assembled under
-- a composition nobody measured, and writing `{}` onto it would assert a shape
-- as a fact. Null on the resume path too (`paused_turns.messages` is a stored
-- transcript with no parts left to measure) and on the continuation update,
-- where the row already describes the request that produced its first half —
-- the same rule `sources` and `grounding` already follow.

alter table public.messages add column if not exists prompt_parts jsonb;

comment on column public.messages.prompt_parts is
  'What the prompt of this reply was assembled from, in characters, as measured '
  'at assembly time: system_chars (the whole system block), manifest_chars, '
  'doc_names, rag_chars, history_turns, history_chars, question_chars, tools '
  '(names), web_search, mode. The token side is prompt_tokens/pass_usage. Null '
  'on a resumed or continued reply, and on every reply written before 0069.';
