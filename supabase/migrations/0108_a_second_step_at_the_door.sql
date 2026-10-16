-- Two-step sign-in, enforced where the data is rather than where the form is.
--
-- Supabase Auth issues a session at `aal1` after a password and at `aal2` once
-- a second factor has been verified on top of it. The sign-in page asking for
-- a code is courtesy. PostgREST is on the internet, and somebody holding a
-- password for an account with an authenticator can take the `aal1` token
-- GoTrue hands them straight to `/rest/v1` without ever seeing that page. So
-- the rule has to live in Postgres, which is where every other rule here lives.
--
-- 1. `second_factor_satisfied()` is the rule: true for an `aal2` token, and
--    true for anybody with no verified factor — an account that never turned
--    two-step on loses nothing. It is `security definer` because the answer is
--    in `auth.mfa_factors`, which no client role can read.
-- 2. `require_second_factor()` applies it to every PostgREST request, before
--    the request touches anything, as `pgrst.db_pre_request`. One hook rather
--    than a restrictive policy per table, for two reasons. A table added next
--    month is covered without anybody remembering. And a policy only guards a
--    table: the `security definer` RPCs read past policies by design, so a
--    policy-only rule would leave every one of them answering an `aal1` caller.
--    The hook runs for every role, so it is an invoker function that anon may
--    execute, and it asks the definer question only of a signed-in caller.
-- 3. Realtime does not go through PostgREST. It decides what to deliver by
--    evaluating each table's policies as the subscriber, so the three tables in
--    `supabase_realtime` get the same rule as a restrictive policy.
--
-- Tokens minted for API keys (worker/src/lib/api-keys.ts) carry `aal2`. A key
-- can only be created through PostgREST, so for an account with a factor it
-- can only be created by a session that already passed the second step.

-- ===========================================================================
-- 1. The rule
-- ===========================================================================

create or replace function public.second_factor_satisfied()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (
        select 1
          from auth.mfa_factors f
         where f.user_id = auth.uid()
           and f.status = 'verified'
      )
$$;

revoke all on function public.second_factor_satisfied() from public, anon;
grant execute on function public.second_factor_satisfied() to authenticated, service_role;

-- ===========================================================================
-- 2. Every PostgREST request
-- ===========================================================================

-- Not `security definer`: anon and service_role run this too, on every request,
-- and the only thing it needs to know about them is that they are not a
-- signed-in person. `PT403` is PostgREST's spelling of "answer 403".
create or replace function public.require_second_factor()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return;
  end if;

  if not public.second_factor_satisfied() then
    raise sqlstate 'PT403' using message = 'second factor required';
  end if;
end;
$$;

alter role authenticator set pgrst.db_pre_request = 'public.require_second_factor';
notify pgrst, 'reload config';

-- ===========================================================================
-- 3. Realtime
-- ===========================================================================

do $$
declare
  t text;
begin
  foreach t in array array['messages', 'chat_sessions', 'ideas'] loop
    execute format('drop policy if exists %I on public.%I', t || '_second_factor', t);
    execute format(
      'create policy %I on public.%I as restrictive for select to authenticated '
      'using ((select public.second_factor_satisfied()))',
      t || '_second_factor', t);
  end loop;
end $$;
