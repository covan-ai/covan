-- =========================================================================
-- An agent you can ask from a channel
--
-- 0012 already sends *to* Slack: a routine posts its digest through a webhook
-- URL somebody pasted into Settings. This is the other direction, and it is a
-- different kind of thing — not a delivery address but a surface, where the
-- question is asked and answered in the place the team is already standing.
--
-- The whole design decision is in `slack_identities`. A Slack message arrives
-- with a Slack user id and nothing else, and the tempting shortcut is to run it
-- as whoever installed the app: one row, no lookup, works immediately. It is
-- also the end of tenancy. Every reply would be retrieved with the installer's
-- access, so a member who cannot see a bundle in Covan could read it out of a
-- channel — and the audit trail would say the installer asked. So a Slack user
-- is a Covan user or is nobody, and the mapping is made once, by email, and
-- stored. Somebody with no Covan account gets told so, which is a worse first
-- experience and the only honest one.
-- =========================================================================

-- ---- slack_installations -------------------------------------------------
-- One row per connected Slack workspace. `secret_ciphertext` is the bot token,
-- encrypted by the worker (AES-GCM) under ROUTINE_SECRET_KEY before it is ever
-- written — the same envelope as `delivery_channels` and `connections`.
create table if not exists public.slack_installations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Slack's own ids, and the join key for every incoming event. Unique because
  -- an event carries a team and has to resolve to exactly one workspace: two
  -- rows for one team would be a question with two possible answers, and the
  -- engine would pick whichever sorted first.
  team_id text not null unique,
  team_name text not null,
  -- So the app can recognise its own messages and not answer them.
  bot_user_id text not null,
  secret_ciphertext text not null,
  -- Which agent answers. Set to the workspace's oldest agent at install time so
  -- the app works before anybody configures anything, and changed from the
  -- Integrations page. `set null` rather than cascade: deleting an agent must
  -- not silently uninstall Slack, it must make the app say which choice is
  -- missing.
  agent_id uuid references public.agents (id) on delete set null,
  installed_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One Slack per workspace. Two would mean a workspace whose agent answers in
-- two Slacks with one set of knowledge and no way to tell them apart in the
-- interface — a feature to add deliberately, if ever, rather than to inherit
-- from a missing constraint.
create unique index if not exists slack_installations_workspace_idx
  on public.slack_installations (workspace_id);

alter table public.slack_installations enable row level security;

drop policy if exists "slack_installations_select_member" on public.slack_installations;
create policy "slack_installations_select_member"
  on public.slack_installations for select
  using (public.is_workspace_member(workspace_id));

-- Choosing the agent is a workspace decision, so an admin can make it as well
-- as the person who installed it — the same reasoning as `connections`, and the
-- same failure it avoids: an installer who leaves taking the setting with them.
drop policy if exists "slack_installations_update_owner_or_admin" on public.slack_installations;
create policy "slack_installations_update_owner_or_admin"
  on public.slack_installations for update
  using (installed_by = auth.uid() or public.is_workspace_admin(workspace_id))
  with check (
    (installed_by = auth.uid() or public.is_workspace_admin(workspace_id))
    and public.can_write_in_workspace(workspace_id)
    and (
      agent_id is null
      or exists (
        select 1 from public.agents a
        where a.id = slack_installations.agent_id
          and a.workspace_id = slack_installations.workspace_id
      )
    )
  );

drop policy if exists "slack_installations_delete_owner_or_admin" on public.slack_installations;
create policy "slack_installations_delete_owner_or_admin"
  on public.slack_installations for delete
  using (installed_by = auth.uid() or public.is_workspace_admin(workspace_id));

revoke all on public.slack_installations from anon, authenticated;
grant select (
  id, workspace_id, team_id, team_name, bot_user_id, agent_id, installed_by,
  created_at, updated_at
) on public.slack_installations to authenticated;
grant update (agent_id) on public.slack_installations to authenticated;
grant delete on public.slack_installations to authenticated;

-- ---- slack_identities ----------------------------------------------------
-- Who a Slack user is in Covan. Written by the events endpoint the first time
-- somebody asks something, by matching the email Slack reports against a
-- profile in this workspace.
create table if not exists public.slack_identities (
  installation_id uuid not null references public.slack_installations (id) on delete cascade,
  slack_user_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (installation_id, slack_user_id)
);

create index if not exists slack_identities_user_idx
  on public.slack_identities (user_id);

alter table public.slack_identities enable row level security;

-- Visible to the workspace, because "who is Covan answering as" is a question
-- the workspace is entitled to ask about its own channels. It discloses a
-- mapping between two directories the same people are already in.
drop policy if exists "slack_identities_select_member" on public.slack_identities;
create policy "slack_identities_select_member"
  on public.slack_identities for select
  using (
    exists (
      select 1 from public.slack_installations i
      where i.id = slack_identities.installation_id
        and public.is_workspace_member(i.workspace_id)
    )
  );

-- Unlinking is yours to do, and an admin's. There is no update policy on
-- purpose: a mapping is created by matching an email or not at all, and a
-- mapping that could be edited is a mapping that could be pointed at somebody
-- else.
drop policy if exists "slack_identities_delete_own_or_admin" on public.slack_identities;
create policy "slack_identities_delete_own_or_admin"
  on public.slack_identities for delete
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.slack_installations i
      where i.id = slack_identities.installation_id
        and public.is_workspace_admin(i.workspace_id)
    )
  );

revoke all on public.slack_identities from anon, authenticated;
grant select on public.slack_identities to authenticated;
grant delete on public.slack_identities to authenticated;

-- ---- slack_threads -------------------------------------------------------
-- One Slack thread is one Covan conversation. Its own table rather than a
-- marker inside `chat_sessions.title`, because the title is what a person reads
-- in the sidebar and a lookup key hidden in it would be a lookup key somebody
-- renames.
create table if not exists public.slack_threads (
  installation_id uuid not null references public.slack_installations (id) on delete cascade,
  channel_id text not null,
  thread_ts text not null,
  session_id uuid not null references public.chat_sessions (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (installation_id, channel_id, thread_ts)
);

create index if not exists slack_threads_session_idx
  on public.slack_threads (session_id);

alter table public.slack_threads enable row level security;

-- Readable by the workspace, so the interface can mark a conversation as one
-- that happened in Slack. Written only by the service role — a client that
-- could insert here could attach a Slack thread to somebody else's session.
drop policy if exists "slack_threads_select_member" on public.slack_threads;
create policy "slack_threads_select_member"
  on public.slack_threads for select
  using (
    exists (
      select 1 from public.slack_installations i
      where i.id = slack_threads.installation_id
        and public.is_workspace_member(i.workspace_id)
    )
  );

revoke all on public.slack_threads from anon, authenticated;
grant select on public.slack_threads to authenticated;
