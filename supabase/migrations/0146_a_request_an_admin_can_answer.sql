-- =========================================================================
-- A request an admin can answer
--
-- 0143 lets an admin of a workspace answer a routine's request that is not
-- theirs: a routine is the team's standing order, and its owner may be
-- asleep when the mail that set it off arrives. The admin could answer it
-- from its page, but nothing put it in front of them. This is the list, and
-- the count beside the Inbox.
--
-- `delegated_approvals` is a definer function because what the row needs to
-- say — whose routine, which one — is in rows the admin may not read: a
-- private routine is its owner's, and so is the conversation it asks in. It
-- answers the names and the request's own sentence and arguments (what the
-- admin is asked to agree to), never the conversation, the prompt or the raw
-- call. Only to an admin of the workspace, and only other people's routine
-- requests: the admin's own are already in their Inbox as their own threads,
-- and a conversation's question is never anybody else's to answer.
-- =========================================================================

create or replace function public.delegated_approvals(p_workspace_id uuid)
returns table (
  id            uuid,
  agent_id      uuid,
  agent_name    text,
  owner_id      uuid,
  owner_name    text,
  routine_id    uuid,
  routine_name  text,
  tool          text,
  summary       text,
  proposal      jsonb,
  created_at    timestamptz,
  expires_at    timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.id, p.agent_id, a.name, p.user_id, owner.name, r.id, r.name,
         p.tool, p.summary, p.proposal, p.created_at, p.expires_at
    from public.paused_turns p
    join public.routine_runs run on run.id = p.routine_run_id
    join public.routines r on r.id = run.routine_id
    join public.agents a on a.id = p.agent_id
    left join public.profiles owner on owner.id = p.user_id
   where public.is_workspace_admin(p_workspace_id)
     and p.workspace_id = p_workspace_id
     and p.origin = 'routine'
     and p.status = 'pending'
     and p.expires_at > now()
     and p.user_id <> auth.uid()
   order by p.created_at desc
   limit 50;
$$;

revoke all on function public.delegated_approvals(uuid) from public, anon;
grant execute on function public.delegated_approvals(uuid) to authenticated, service_role;

-- The Inbox's counts and the sidebar's: an admin's Needs you counts the
-- requests they may answer for somebody else, under the agent that asked.
create or replace function public.inbox_counts(p_workspace_id uuid)
returns table (
  agent_id   uuid,
  unread     integer,
  needs_you  integer,
  running    integer
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with own as (
    select r.agent_id,
           count(*) filter (where r.unread_count > 0)::integer          as unread,
           count(*) filter (where r.needs_kind is not null)::integer     as needs_you,
           count(*) filter (where r.running_since is not null)::integer  as running
      from public.inbox_rows(p_workspace_id, 'all', null, null, null, null) r
     where r.unread_count > 0 or r.needs_kind is not null or r.running_since is not null
     group by r.agent_id
  ),
  delegated as (
    select d.agent_id, count(*)::integer as needs_you
      from public.delegated_approvals(p_workspace_id) d
     group by d.agent_id
  )
  select coalesce(o.agent_id, d.agent_id),
         coalesce(o.unread, 0),
         coalesce(o.needs_you, 0) + coalesce(d.needs_you, 0),
         coalesce(o.running, 0)
    from own o
    full join delegated d on d.agent_id = o.agent_id;
$$;

revoke all on function public.inbox_counts(uuid) from public, anon;
grant execute on function public.inbox_counts(uuid) to authenticated, service_role;
