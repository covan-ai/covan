-- =========================================================================
-- Whether anything the team wrote was close to the question
--
-- covan#44 wants to report what a team asked that its own written knowledge
-- does not cover, so somebody can see what to write down next. The issue
-- assumed the signal was already recorded: "when a question falls below the
-- similarity floor, that is a recorded fact". It is neither recorded nor,
-- on its own, the fact it sounds like.
--
-- Nothing is written down. `messages.sources` (0005) names the documents that
-- grounded a reply, but there are two ways to arrive at a grounded reply and
-- the column cannot tell them apart. `worker/src/routes/chat.ts` first asks
-- `match_chunks` for passages above `RAG_MIN_SIMILARITY`; if none clears it, a
-- fallback grounds the answer on whole documents instead, newest first, under
-- the same character budget. Both paths fill `sources`. So a reply with
-- sources may mean "a passage matched" or "nothing matched and we sent the
-- newest files anyway", and only the first means the question was covered.
--
-- Hence one column recording which of the three happened:
--
--   'chunks'    at least one passage cleared the floor — the question was
--               covered by something written for it
--   'documents' nothing cleared the floor; the fallback grounded the reply on
--               whole documents. The answer may still be right, and often is
--               for "summarise the file" questions, but no passage in the
--               team's knowledge was a close match for what was asked
--   'none'      nothing grounded it. The agent has no usable documents at all,
--               which is a setup problem rather than a coverage one, and the
--               report will want to say so differently
--
-- The distinction matters for what the report is allowed to claim. "Questions
-- we could not answer" would be false — the fallback answers most of them.
-- "Questions nothing written was close to" is true, and is the one a founder
-- can act on.
--
-- Null is the honest value for every row written before today, and for every
-- user message. It is not a fourth state; it means nobody recorded one.
-- =========================================================================

alter table public.messages
  add column grounding text;

-- Two conditions in one constraint, because they are one rule: this column
-- describes how an assistant reply was grounded, so only an assistant row may
-- carry it, and only with a value the reader will recognise.
--
-- The role half is not decoration. `messages_insert_user_self` (0009) and
-- `messages_update_owner` (0031) both pin a member to `role = 'user'`, so a
-- member can only ever write their own question — and without this constraint
-- they could stamp a grounding on it and quietly become the source of a number
-- the report is built from.
alter table public.messages
  add constraint messages_grounding_valid check (
    grounding is null
    or (role = 'assistant' and grounding in ('chunks', 'documents', 'none'))
  );

-- The report reads "assistant replies in this workspace, over a window, where
-- nothing came close". Sessions carry the workspace and the timestamp lives on
-- the message, so the useful index is the one that lets a scan start from the
-- grounding rather than from every message ever sent.
--
-- Partial, because the rows worth reporting on are a minority and always will
-- be: an index over all of `messages` would be mostly `'chunks'` and mostly
-- read past.
create index if not exists messages_grounding_missed_idx
  on public.messages (session_id, created_at)
  where grounding in ('documents', 'none');
