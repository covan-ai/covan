-- =========================================================================
-- 0074 — what nobody wrote down yet
--
-- 0039 recorded how every reply was grounded. 0053 read those counts — by
-- agent, by window, admin-only — and stopped there, deliberately, with a ruling
-- in its header: the counts disclose nothing and could ship, and "the questions
-- behind them are a separate feature with a consent step in front of it: the
-- person who asked decides whether their question joins the team's gap list."
--
-- This is that feature, and it does NOT have that consent step. The reason is
-- written down here because this migration overrides a decision somebody made
-- carefully.
--
-- 0053 was right about the thing it was looking at: a list of verbatim
-- questions is a list of what colleagues typed in private rooms. Per-asker
-- consent is the right answer to THAT feature. It is the wrong answer to this
-- one, and the reason is about the report rather than about privacy — a gap
-- list whose contents are a function of who clicked yes has an unknowable
-- sampling bias, and "what should we write down next" is answered WRONGLY by a
-- biased sample rather than partially. It would also put another question in
-- front of somebody mid-conversation.
--
-- What replaces it does the same work structurally, in three parts:
--
--   1. No question ever reaches an admin. What reaches them is a topic label
--      over a group of at least N, and the floor and the containment check run
--      in our code on what the model returned — `lib/routines/coverage-cluster.ts`
--      — not as a request inside a prompt.
--   2. Any member can exclude themselves, retroactively, and NOBODY can see who
--      did. That is the SELECT policy below and it is a feature, not an
--      oversight.
--   3. The whole thing is off until a workspace turns it on, so no existing
--      workspace starts producing a report because of a deploy.
--
-- =========================================================================
-- THE CALLER, AND WHY BOTH READS TAKE A USER ID
-- =========================================================================
--
-- The plan for this migration had both reads call `is_workspace_admin`, the
-- way 0053's pair do. THAT FUNCTION CAN NEVER PASS FOR THE CALLER THAT RUNS
-- THE REPORT, and the feature would not have worked once.
--
-- `is_workspace_admin` (0003) asks `wm.user_id = auth.uid()`, and `auth.uid()`
-- reads `request.jwt.claim.sub` out of a session setting PostgREST fills in
-- from the caller's JWT. The routines engine runs under the SERVICE ROLE —
-- `worker/src/lib/routines/dispatcher.ts` builds its client as
-- `overrides.db ?? serviceClient(env)` on all three entry points — and a
-- service-role JWT carries no `sub`. Measured on the local stack: with the
-- service-role key, `auth.uid()` is null and `request.jwt.claims` is
-- `{"role":"service_role",...}` with no `sub` in it. So `is_workspace_admin`
-- is false and the function raises 42501 on every scheduled run.
--
-- A routine has no user session to borrow. It runs on a cron, hours after
-- anybody signed in, and `userClient(env, token)` has no token to be handed.
-- The plan half-noticed this: 0053's grant comment, copied into the plan,
-- observes that `auth.uid()` is null for an anonymous caller and treats that as
-- a defence — without noticing it is equally true of the `service_role` the
-- very next line grants EXECUTE to.
--
-- So both reads take the owner's user id explicitly:
--
--     workspace_coverage_gaps(p_workspace_id, p_user_id, p_days)
--     workspace_coverage_totals(p_workspace_id, p_user_id, p_days)
--
-- and each checks that **`p_user_id`** is an admin of `p_workspace_id`.
--
-- One alternative was found and rejected rather than missed: a definer wrapper
-- could `set_config('request.jwt.claim.sub', p_user_id::text, true)` and then
-- call 0053's function, which would pass. That is forging an identity rather
-- than checking one — the forged GUC is visible to every policy evaluated
-- later in the same transaction, so a function that wanted to read one table
-- as somebody would silently read all of them as that somebody. An explicit
-- argument that the function validates is the same capability with a blast
-- radius of one call. Minting a user JWT in the worker was also ruled out: the
-- hosted project signs with ES256 through JWKS, so there is no shared secret to
-- mint with, and `SUPABASE_JWT_SECRET` is optional and verify-only.
--
-- ---- the escalation guard "act as this user" needs ------------------------
--
-- A SECURITY DEFINER function that takes a user id is an impersonation
-- primitive if nothing stops a caller naming somebody else. `authenticated`
-- holds EXECUTE below, so without a guard any signed-in member could read
-- their workspace's gap list by passing an admin's id — and `authenticated` is
-- reachable with the anon key that ships in the browser bundle plus any
-- password.
--
-- Closed inside the function, in one line and in both of them:
--
--     if auth.uid() is not null and p_user_id is distinct from auth.uid()
--
-- A caller with a session may therefore only ever ask about THEMSELVES — the
-- argument becomes a restatement of who they already are, and the function is
-- exactly as capable as 0053's for them. A caller with no session
-- (`auth.uid()` null) is the service role, which already bypasses RLS on every
-- table these functions read, so letting it name the routine's owner grants it
-- nothing it did not have.
--
-- `is distinct from`, not `<>`, so a null `p_user_id` from a signed-in caller
-- is refused here rather than falling through to the admin check.
--
-- ---- `anon` ALSO HAS A NULL auth.uid(), AND THE OBVIOUS GRANT DOES NOT ------
-- ---- KEEP IT OUT -----------------------------------------------------------
--
-- 0053's grant block revokes PUBLIC and grants `authenticated, service_role`,
-- and the plan copied it here. MEASURED ON THIS STACK, THAT LEAVES `anon` WITH
-- EXECUTE. Supabase ships
-- `alter default privileges ... grant execute on functions to anon,
-- authenticated, service_role`, so a newly created function is granted to
-- `anon` BY NAME rather than through PUBLIC — and `revoke ... from public` does
-- not touch a grant held by name. `select has_function_privilege('anon', ...)`
-- answers true for 0053's two functions to this day.
--
-- For 0053 that is untidy and not a hole: its guard is
-- `is_workspace_admin(p_workspace_id)`, which is false for a null
-- `auth.uid()`, so an anonymous caller is refused by the body. THESE TWO
-- FUNCTIONS DO NOT REFUSE A NULL `auth.uid()` — that is how the service role
-- gets in — so for them the grant was the entire boundary, and it was not
-- holding. Reproduced before this was written: with nothing but the anon key
-- (which ships in the browser bundle), a workspace id and an admin's user id,
-- `POST /rest/v1/rpc/workspace_coverage_gaps` returned a result rather than an
-- error. Both of those ids are readable by any plain member of the workspace —
-- `workspace_members_select_fellow_members` (0001) hands over `user_id` and
-- `role` — so this was the escalation guard above being walked around by
-- dropping the Authorization header.
--
-- Closed twice, on purpose, because the thing that went wrong here was a grant
-- nobody looked at:
--
--   1. `revoke execute ... from anon` BY NAME, at the bottom of this file. This
--      is the boundary: Postgres checks it before the body runs.
--   2. A second condition in the body — when there is no `auth.uid()`, the
--      JWT's own `role` claim must be `service_role`. `auth.role()` reads the
--      same verified claims `auth.uid()` does, so it is no weaker a source. It
--      costs three lines and it means a future `grant execute ... to anon`,
--      or another `alter default privileges` arriving with a Supabase upgrade,
--      is a feature that does not work rather than a disclosure.
--
-- The cost of (2) is owned: a caller with no `request.jwt.claims` at all — a
-- `psql` session, a maintenance script — is refused too, and the message says
-- so rather than leaving somebody to guess.
--
-- ---- why 0053's `workspace_coverage` is not reused for the totals ---------
--
-- The plan said to reuse it. It has the same `auth.uid()` problem, so reusing
-- it means fixing it — which means replacing a shipped function that the live
-- coverage screen depends on (`worker/src/routes/coverage.ts` calls it on every
-- load of that screen), inside the same migration that adds a
-- privacy-sensitive read. Duplicating about twenty lines of aggregation is the
-- cheaper risk of the two.
--
-- `workspace_coverage_totals` below is therefore 0053's aggregation restated
-- under the new caller model and NOTHING ELSE. **The two must stay in step.**
-- A change to the buckets in either one belongs in both, and the comment on
-- each says so.
-- =========================================================================

-- ---- the switch ----------------------------------------------------------
-- 0014's precedent for a workspace-level setting. Default false is the whole of
-- its safety.

alter table public.workspaces
  add column if not exists gap_report_enabled boolean not null default false;

comment on column public.workspaces.gap_report_enabled is
  'Whether this workspace has turned the coverage gap report on. False for '
  'every workspace that existed before 0074, and the reads below refuse to '
  'return anything while it is false.';

-- ---- two guards that belong in 0073 --------------------------------------
--
-- Both are here only because 0073 is already applied to the local database and
-- an applied migration does not get edited. Conceptually they are 0073's: they
-- are about the row that migration's `source_kind` introduced.

-- (1) `source_config` has to say WHICH report.
--
-- 0073's own header says `source_config` names the report and the next task
-- constructs `{"report": "coverage_gaps"}` — but nothing refuses `{}`, which is
-- the column default. A routine created with no report key is permanently
-- broken rather than temporarily wrong: 0027's
-- `trg_routines_source_config_immutable` refuses every update to
-- `source_config`, so the only repair is to delete the routine and make it
-- again.
--
-- `routines_connection_config_check` (0047) is the precedent — a shape guard
-- for the kind its migration introduced, written as a CHECK rather than a
-- policy clause because the executor and the service role are callers too.
-- Same `coalesce`, and for 0047's reason: `->>` on a missing key yields NULL,
-- `NULL ~ ...` is NULL, and a CHECK only refuses FALSE, so without the
-- `coalesce` a `{}` config passes the one guard that applies when row level
-- security does not. (`->>` on a JSON array or scalar also yields NULL, so a
-- `source_config` that is not an object is refused rather than raising.)
--
-- A pattern rather than an `in ('coverage_gaps')` list, deliberately: 0073
-- promises that the second report — `{"report": "stale_documents"}` — needs no
-- constraint change, no policy rewrite and no migration, and an enumeration
-- here would break that promise on the day it is collected. The pattern is
-- what a report name is: a snake_case identifier, bounded, so a config
-- carrying forty kilobytes of junk under the `report` key is still refused.
alter table public.routines drop constraint if exists routines_workspace_config_check;
alter table public.routines
  add constraint routines_workspace_config_check
  check (
    source_kind <> 'workspace'
    or coalesce(source_config ->> 'report', '') ~ '^[a-z][a-z0-9_]{0,63}$'
  );

-- (2) A routine that reads its own workspace must be PRIVATE.
--
-- `routine_runs_select_visible` (0012) admits
-- `r.visibility = 'shared' and is_workspace_member(r.workspace_id)`, and
-- `routine_runs.summary` is where the delivered report is kept (0056). So an
-- admin flipping one of these routines to `shared` makes every delivered
-- coverage report readable by every plain member of the workspace — which is
-- the exact population this whole design keeps the report away from. Nothing
-- else refuses it: `visibility` is a column the edit dialog changes, and
-- 0073's guard never looks at it.
--
-- DELIBERATELY A CHECK AND NOT A POLICY CLAUSE. A fourth argument to
-- `routine_workspace_source_is_permitted` would mean dropping and recreating
-- that function and then both policies on `routines` again — the riskiest
-- operation in this phase, and the one 0073's header counts five previous
-- hand-copies of. A CHECK needs no policy rewrite, cannot lose a clause
-- somebody carried forward wrong, and binds the service role as well, which a
-- policy does not.
alter table public.routines drop constraint if exists routines_workspace_source_private_check;
alter table public.routines
  add constraint routines_workspace_source_private_check
  check (source_kind <> 'workspace' or visibility = 'private');

-- ---- (3) the guard, inverted to an allow-list ----------------------------
--
-- 0073 wrote the body as `p_source_kind <> 'workspace' or (...)`, which answers
-- TRUE for any kind it has never heard of — the same default-open shape its own
-- header criticises in 0047's `routine_source_is_visible` two paragraphs
-- earlier. A `source_kind` added in 0085 by somebody solving a different
-- problem would sail through the one gate on this table that is about
-- privilege, and nothing would fail.
--
-- Inverted, a new kind is refused until somebody decides about it: adding a
-- kind to `routines_source_kind_check` and forgetting this list produces a
-- feature that does not work, which is a bug report. Forgetting it the other
-- way round produces a privilege hole, which is not.
--
-- Safe with `create or replace` on the SAME SIGNATURE: both policies reference
-- the function by name and stay valid, so neither is touched here. The body is
-- the only thing that changes, and `routine-policy.static.test.ts` reads policy
-- text rather than function bodies, so it is unaffected.
create or replace function public.routine_workspace_source_is_permitted(
  p_source_kind text,
  p_workspace_id uuid,
  p_output_bundle_id uuid
) returns boolean
language sql
stable
-- Still deliberately NOT security definer, and still with no `set search_path`,
-- for the two reasons 0073 gives at length: a policy helper must ask as the
-- caller, and a function with a SET clause cannot be inlined by the planner,
-- which inside a per-row policy expression is a cost paid for nothing.
as $$
  select p_source_kind in ('rss', 'web', 'none', 'connection')
      or (p_source_kind = 'workspace'
          and public.is_workspace_admin(p_workspace_id)
          and p_output_bundle_id is null);
$$;

comment on function public.routine_workspace_source_is_permitted(text, uuid, uuid) is
  'True for the source kinds that need no privilege (rss, web, none, '
  'connection); true for ''workspace'' only when the caller is an admin of it '
  'and the routine would file nothing as a document; FALSE for any kind not '
  'named — an allow-list, so a source kind added later is refused until '
  'somebody decides about it. Runs as the caller; must not become SECURITY '
  'DEFINER.';

-- ---- the opt-out, and why it is a table ----------------------------------
--
-- THE OBVIOUS MOVE IS A COLUMN ON `workspace_members` AND IT OPENS A PRIVILEGE
-- ESCALATION. Worth the paragraph, because the obvious move is what a later
-- refactor will reach for, and reaching for it is not a simplification.
--
-- UPDATE on that table is admin-only (`workspace_members_update_admin`, 0003),
-- which uses `is_workspace_admin(workspace_id)` for both its USING and its
-- WITH CHECK — so a member cannot set their own flag, which defeats the point.
-- Adding a policy that lets them update their own row would also let them send
-- `role: 'admin'` in the same request, because A ROW-LEVEL POLICY CANNOT TELL
-- ONE COLUMN FROM ANOTHER and `authenticated` holds a table-level UPDATE there
-- from 0023 with no column list. The only fix within that table is
-- column-level grants, which means re-cutting the grants on the table where
-- role changes live.
--
-- A separate table needs none of that. Presence is the fact, which is
-- `routine_deliveries`' shape (0012) and needs no boolean.
--
-- `tests/rls/coverage-gaps.test.ts` keeps a live regression test for the
-- escalation itself, so that a later move back onto `workspace_members` is a
-- red test rather than a quiet privilege grant.

create table if not exists public.coverage_opt_outs (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

comment on table public.coverage_opt_outs is
  'One row per member who has excluded themselves from their workspace''s '
  'coverage gap report. Presence is the fact; SELECT is self-only, including '
  'for admins, so nobody can learn who excluded themselves. Deliberately not a '
  'column on workspace_members — see 0074''s header.';

alter table public.coverage_opt_outs enable row level security;

-- Grants named rather than inherited, which is 0023's closing instruction: from
-- there on a migration that adds a table grants for it, because a grant written
-- down beats an inherited one nobody re-reads. NO UPDATE: there is nothing to
-- update — the row exists or it does not — and granting it would be a column
-- nobody guarded, since no UPDATE policy exists to narrow it.
revoke all on public.coverage_opt_outs from anon, authenticated;
grant select, insert, delete on public.coverage_opt_outs to authenticated;

drop policy if exists "coverage_opt_outs_insert_self" on public.coverage_opt_outs;
create policy "coverage_opt_outs_insert_self"
  on public.coverage_opt_outs for insert
  with check (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  );

drop policy if exists "coverage_opt_outs_delete_self" on public.coverage_opt_outs;
create policy "coverage_opt_outs_delete_self"
  on public.coverage_opt_outs for delete
  using (user_id = auth.uid());

-- SELF ONLY, INCLUDING FOR ADMINS, AND THAT IS THE POINT.
--
-- An admin who could list the opt-outs would learn which individuals chose to
-- hide something — a sharper signal about a person than anything the report
-- itself carries, and one nobody opted into by declining to opt in. The floor
-- is counted inside the definer function below, which can see every row and
-- returns only an opaque integer per asker.
drop policy if exists "coverage_opt_outs_select_self" on public.coverage_opt_outs;
create policy "coverage_opt_outs_select_self"
  on public.coverage_opt_outs for select
  using (user_id = auth.uid());

-- ---- the read ------------------------------------------------------------
--
-- SECURITY DEFINER, the shape 0053's pair uses and for the reason its header
-- gives: a workspace's answers live mostly in sessions the caller cannot see,
-- because chats are private by default (0008), so an admin's own RLS view of
-- `messages` excludes exactly the traffic being asked about.
--
-- Five properties are structural rather than conventions the caller is asked to
-- respect:
--
--   * IT NEVER RETURNS A USER ID. The asker is a `dense_rank()` over user id,
--     scoped to this call — an integer that lets the worker count distinct
--     askers for the floor and carries nothing else. It is not a pseudonym that
--     survives to the next call: the ranking depends on which users appear.
--   * IT TRUNCATES IN SQL. `left(..., 120)` means the full text of a question
--     never crosses the database boundary.
--   * IT EXCLUDES OPTED-OUT MEMBERS, and does so by filtering at read time
--     rather than by stamping each answer when it was written — which is what
--     makes an opt-out RETROACTIVE. A control that only applied going forward
--     would ask somebody to have decided before they knew the feature existed.
--   * IT READS `grounding = 'documents'` ONLY. `'none'` is a setup problem
--     rather than a coverage one — 0053 counts them apart on purpose — so it is
--     reported as its own line by `coverage-render.ts` and never clustered.
--   * IT DROPS ONE-CHARACTER QUESTIONS, which is not tidiness. See the filter.
--
-- Idempotent, because CI does not apply migrations and this is hand-applied and
-- may well be pasted twice. Dropped by exact signature, the shape 0032 and 0053
-- use — including the two-argument signature the plan specified, so a database
-- where that version was pasted before this correction does not keep a function
-- nobody can call successfully.

drop function if exists public.workspace_coverage_gaps(uuid, int);
drop function if exists public.workspace_coverage_gaps(uuid, uuid, int);

create function public.workspace_coverage_gaps(
  p_workspace_id uuid,
  p_user_id uuid,
  p_days int default 7
)
returns table (question text, asker_key int)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  -- Clamped here as well as in the caller, which is 0053's rule: a function
  -- that reads across every private session in a workspace does not take an
  -- unbounded integer from any of them, and an API key is a caller too.
  v_days int := greatest(1, least(coalesce(p_days, 7), 365));
  v_since timestamptz := now() - make_interval(days => v_days);
begin
  -- The escalation guard. A caller with a session may only ask about
  -- themselves; a caller with none has to be the service role. See the header
  -- for why this is the shape — and for the measurement showing that revoking
  -- PUBLIC does NOT keep `anon` out of a function on this stack, which is why
  -- the second half of this is here and not left to the grant alone.
  if auth.uid() is not null then
    if p_user_id is distinct from auth.uid() then
      raise exception 'may only ask about yourself' using errcode = '42501';
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    raise exception
      'a caller with no session may only ask on behalf of the routine runner'
      using errcode = '42501';
  end if;

  -- `is_workspace_admin` asks about `auth.uid()` and cannot be used here; this
  -- is the same question asked about `p_user_id`. Inline rather than a new
  -- `is_workspace_admin_of(uuid, uuid)` helper on purpose: such a helper
  -- granted to `authenticated` would be a probe for "is this person an admin
  -- of that workspace" answerable by anybody with a login, which neither this
  -- feature nor anything else needs. Six duplicated lines beat a new
  -- disclosure surface.
  if not exists (
    select 1 from public.workspace_members wm
     where wm.workspace_id = p_workspace_id
       and wm.user_id = p_user_id
       and wm.role = 'admin'
  ) then
    raise exception 'not an admin of this workspace' using errcode = '42501';
  end if;

  -- The switch is checked HERE and not only in the application, for the reason
  -- the whole of 0073 is about: the route is one caller of several.
  if not exists (
    select 1 from public.workspaces w
     where w.id = p_workspace_id and w.gap_report_enabled
  ) then
    raise exception 'the coverage report is not enabled for this workspace'
      using errcode = '42501';
  end if;

  return query
  with sub as (
    select s.user_id as asker,
           left(btrim(q.content), 120) as text
      from public.messages m
      join public.chat_sessions s on s.id = m.session_id
      -- The question this reply answered: the last user message before it in
      -- the same session. A lateral rather than a window function because the
      -- outer query is already filtered to assistant rows and this needs the
      -- row that is NOT in that set.
      join lateral (
        select m2.content
          from public.messages m2
         where m2.session_id = m.session_id
           and m2.role = 'user'
           and m2.created_at <= m.created_at
         order by m2.created_at desc
         limit 1
      ) q on true
     where s.workspace_id = p_workspace_id
       -- A session somebody deleted is invisible to everyone through RLS
       -- (`chat_sessions_select_owner_or_shared` is `deleted_at is null` with
       -- no branch admitting an admin, and 0040's header says so in as many
       -- words). A definer function reading past RLS has to carry that clause
       -- itself or the deletion is cosmetic — and here the thing it would
       -- resurrect is the TEXT of a question, which is the one thing this
       -- feature exists to keep away from an admin. 0053's pair does not carry
       -- it; they return counts, where the stake is a number being one too
       -- high. The totals function below stays in step with 0053 rather than
       -- with this.
       and s.deleted_at is null
       and m.role = 'assistant'
       and m.grounding = 'documents'
       and m.created_at >= v_since
       -- A ONE-CHARACTER QUESTION IS A STRAY KEYSTROKE, AND EXCLUDING IT IS
       -- LOAD-BEARING. `isQuotation`'s Direction B in
       -- `lib/routines/coverage-cluster.ts` is unconditional and, since fix
       -- round 6, has no length floor on the needle — by design, because four
       -- characters in a script with no inter-word separators is a whole
       -- first-person sentence. The cost is that a one-character question
       -- matches as a raw substring of almost every label: measured over the
       -- thirteen realistic label/question pairs that file's comments cite, a
       -- single vowel in the gap list unnames 8 to 11 of them. So the admin
       -- loses most of the week's topic NAMES because somebody's finger hit a
       -- key. Filtered here rather than in the worker so it also does not
       -- occupy one of the 150 rows below.
       --
       -- On the trimmed length, and the emitted text is trimmed by the same
       -- function, so what is measured is what is returned. Filtered in the
       -- OUTER query rather than inside the lateral: inside it, the lateral
       -- would reach further back and return an older question that this reply
       -- did not answer, which is worse than returning nothing.
       and length(btrim(q.content)) > 1
       and not exists (
         select 1 from public.coverage_opt_outs o
          where o.workspace_id = p_workspace_id
            and o.user_id = s.user_id
       )
     order by m.created_at desc
     -- 150, and the bound is a cost decision as much as a safety one. At 120
     -- characters each that is 18,000 — under `MAX_MATERIAL_CHARS = 20_000` in
     -- `lib/routines/material.ts`, so the price of this prompt is the one that
     -- file has already measured. The worker dedupes before the model call, so
     -- in practice it is usually far fewer.
     limit 150
  )
  select sub.text, (dense_rank() over (order by sub.asker))::int
    from sub;
end;
$$;

comment on function public.workspace_coverage_gaps(uuid, uuid, int) is
  'The questions in a window that found nothing close in the workspace''s own '
  'documents, truncated to 120 characters, with an opaque per-call asker key '
  'and never a user id. `p_user_id` must be an admin of the workspace, and a '
  'caller with a session may only name themselves — see 0074''s header. '
  'Refuses while workspaces.gap_report_enabled is false.';

-- ---- the totals ----------------------------------------------------------
--
-- 0053's `workspace_coverage` aggregation, restated under the caller model
-- above and NOTHING ELSE. The return shape is identical on purpose, so the
-- worker reads one row type whichever function produced it.
--
-- **THESE TWO MUST STAY IN STEP.** A change to the buckets, the denominator or
-- the window in `public.workspace_coverage` (0053) belongs here too, and the
-- reverse. The duplication is deliberate and its reason is in this migration's
-- header: 0053's function is what the live coverage screen calls, and replacing
-- it to fix its caller model inside this migration is a bigger risk than
-- twenty copied lines.
--
-- Deliberately NOT filtered by `coverage_opt_outs`, and deliberately NOT
-- filtered by `chat_sessions.deleted_at` — both of which the gap read above
-- does carry. These are the counts 0053 ships without any gate, on 0053's own
-- argument that a count cannot identify anybody; staying identical to it is
-- what makes "in step" checkable by reading the two side by side. The opt-out
-- is about a member's QUESTIONS joining the gap list, which is the sentence
-- somebody typed, not the denominator it is measured against.

drop function if exists public.workspace_coverage_totals(uuid, int);
drop function if exists public.workspace_coverage_totals(uuid, uuid, int);

create function public.workspace_coverage_totals(
  p_workspace_id uuid,
  p_user_id uuid,
  p_days int default 7
)
returns table (
  answers bigint,
  covered bigint,
  fallback bigint,
  ungrounded bigint,
  unrecorded bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_days int := greatest(1, least(coalesce(p_days, 7), 365));
  v_since timestamptz := now() - make_interval(days => v_days);
begin
  -- The same two guards as `workspace_coverage_gaps`, for the same reasons. See
  -- that function and 0074's header; they are deliberately written out again
  -- rather than factored into a helper, because a definer helper answering "is
  -- this person an admin of that workspace" would be a probe anybody with a
  -- login could run.
  if auth.uid() is not null then
    if p_user_id is distinct from auth.uid() then
      raise exception 'may only ask about yourself' using errcode = '42501';
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    raise exception
      'a caller with no session may only ask on behalf of the routine runner'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.workspace_members wm
     where wm.workspace_id = p_workspace_id
       and wm.user_id = p_user_id
       and wm.role = 'admin'
  ) then
    raise exception 'not an admin of this workspace' using errcode = '42501';
  end if;

  -- Gated by the switch as well, unlike 0053's, so that "the whole thing is off
  -- until a workspace turns it on" is true of every read 0074 adds rather than
  -- of most of them. 0053's function stays ungated; the coverage screen is a
  -- different feature and turning the report off must not empty it.
  if not exists (
    select 1 from public.workspaces w
     where w.id = p_workspace_id and w.gap_report_enabled
  ) then
    raise exception 'the coverage report is not enabled for this workspace'
      using errcode = '42501';
  end if;

  return query
  select count(*) filter (where m.grounding is not null),
         count(*) filter (where m.grounding = 'chunks'),
         count(*) filter (where m.grounding = 'documents'),
         count(*) filter (where m.grounding = 'none'),
         count(*) filter (where m.grounding is null)
  from public.messages m
  join public.chat_sessions s on s.id = m.session_id
  where s.workspace_id = p_workspace_id
    and m.role = 'assistant'
    and m.created_at >= v_since;
end;
$$;

comment on function public.workspace_coverage_totals(uuid, uuid, int) is
  'The grounding counts for a window, in 0053''s four buckets plus its '
  'denominator, for the coverage gap report. Identical aggregation to '
  'public.workspace_coverage — THEY MUST STAY IN STEP — under 0074''s caller '
  'model: `p_user_id` must be an admin, a caller with a session may only name '
  'themselves, and it refuses while workspaces.gap_report_enabled is false.';

-- ---- who may execute -----------------------------------------------------
--
-- A new function grants EXECUTE to PUBLIC by default, which on a SECURITY
-- DEFINER function reading across other people's sessions is not a default to
-- leave in place. Here that is the security boundary rather than hygiene, which
-- is a change from 0053: these two do not refuse a caller for having no
-- `auth.uid()` — that is how the service role gets in — so 0053's comment that
-- the guard inside would refuse an anonymous caller anyway is NOT true of them
-- and must not be copied onto them.
--
-- **AND `revoke ... from public` IS NOT ENOUGH, which is the finding behind
-- this block.** Supabase ships `alter default privileges ... grant execute on
-- functions to anon, authenticated, service_role`, so `anon` holds EXECUTE on
-- a new function BY NAME — a grant `revoke ... from public` cannot reach.
-- Verified by reproducing an anonymous read of a gap list before this line was
-- added, and verified again afterwards; `tests/rls/coverage-gaps.test.ts`
-- keeps the regression. `anon` is therefore revoked by name as well, and
-- 0053's pair is left alone: untidy there, but its own guard refuses a null
-- `auth.uid()`, so there is nothing to fix inside the migration that adds this
-- read.
revoke execute on function public.workspace_coverage_gaps(uuid, uuid, int)
  from public, anon;
revoke execute on function public.workspace_coverage_totals(uuid, uuid, int)
  from public, anon;
grant execute on function public.workspace_coverage_gaps(uuid, uuid, int)
  to authenticated, service_role;
grant execute on function public.workspace_coverage_totals(uuid, uuid, int)
  to authenticated, service_role;
