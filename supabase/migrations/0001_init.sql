-- 0001_init.sql
-- Covan initial schema: tables, indexes, Row Level Security policies,
-- and the signup bootstrap trigger (profile + default workspace + admin membership).
--
-- Tenancy model:
--   - Agents are shared within a workspace.
--   - Chat sessions (and messages, favorites) are private per user.
--   - A user belongs to one or more workspaces via workspace_members.
--   - On signup, every new user automatically gets: a profiles row, a
--     personal default workspace, and an 'admin' workspace_members row.

-- pgcrypto is enabled by default on Supabase and provides gen_random_uuid().
create extension if not exists pgcrypto;

-- =========================================================================
-- Tables (created in FK-dependency order)
-- =========================================================================

-- profiles: 1:1 with auth.users
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text,
  avatar_url text,
  email text,
  created_at timestamptz not null default now()
);

-- workspaces
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

-- workspace_members: join table linking users to workspaces with a role
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- agents: shared within a workspace
create table public.agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  emoji text,
  model text,
  persona text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

-- documents: belong to an agent; r2_key is nullable until Phase 3 (R2 upload)
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  name text not null,
  size bigint,
  r2_key text,
  created_at timestamptz not null default now()
);

-- chat_sessions: private per user
create table public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- messages: belong to a chat session
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

-- favorites: private per user
create table public.favorites (
  user_id uuid not null references auth.users (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, agent_id)
);

-- =========================================================================
-- Indexes on foreign keys used by policies / common queries
-- =========================================================================

create index idx_agents_workspace_id on public.agents (workspace_id);
create index idx_documents_agent_id on public.documents (agent_id);
create index idx_chat_sessions_agent_id on public.chat_sessions (agent_id);
create index idx_chat_sessions_user_id on public.chat_sessions (user_id);
create index idx_messages_session_id on public.messages (session_id);
create index idx_workspace_members_user_id on public.workspace_members (user_id);
create index idx_favorites_agent_id on public.favorites (agent_id);

-- =========================================================================
-- Row Level Security
-- =========================================================================

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.agents enable row level security;
alter table public.documents enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.messages enable row level security;
alter table public.favorites enable row level security;

-- ---- profiles ------------------------------------------------------------
-- A user can see their own profile AND the profiles of anyone who shares at
-- least one workspace with them (needed by the /me endpoint and team page,
-- which list co-members: name, avatar, email). Update/insert stay own-only.
--
-- shares_workspace() is SECURITY DEFINER so it can query workspace_members
-- with RLS bypassed; this avoids re-triggering workspace_members RLS (and any
-- recursion) from within the profiles policy.

create function public.shares_workspace(p_user uuid)
returns boolean
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.workspace_members me
    join public.workspace_members them on them.workspace_id = me.workspace_id
    where me.user_id = auth.uid()
      and them.user_id = p_user
  );
$$;

create policy "profiles_select_own_or_shared_workspace"
  on public.profiles for select
  using (id = auth.uid() or public.shares_workspace(id));

create policy "profiles_update_own"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (id = auth.uid());

-- ---- workspaces ------------------------------------------------------------
-- Members can see workspaces they belong to. Admin members can update.
-- Any authenticated user can create a workspace they own.

create policy "workspaces_select_member"
  on public.workspaces for select
  using (
    exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = workspaces.id
        and wm.user_id = auth.uid()
    )
  );

create policy "workspaces_update_admin"
  on public.workspaces for update
  using (
    exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = workspaces.id
        and wm.user_id = auth.uid()
        and wm.role = 'admin'
    )
  )
  with check (
    exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = workspaces.id
        and wm.user_id = auth.uid()
        and wm.role = 'admin'
    )
  );

create policy "workspaces_insert_owner"
  on public.workspaces for insert
  with check (created_by = auth.uid());

-- ---- workspace_members ------------------------------------------------------------
-- A user can see membership rows for workspaces they themselves belong to.
--
-- A plain EXISTS subquery against workspace_members from within its own
-- SELECT policy causes Postgres to detect infinite recursion at runtime
-- ("infinite recursion detected in policy for relation workspace_members"),
-- because evaluating the policy for the outer row requires re-evaluating
-- the (same) policy for the inner rows, and so on. The standard, safe fix
-- is a SECURITY DEFINER helper function: it queries the table with RLS
-- bypassed (owner privileges), so the policy itself never re-invokes RLS
-- on workspace_members.

create function public.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = auth.uid()
  );
$$;

create policy "workspace_members_select_fellow_members"
  on public.workspace_members for select
  using (public.is_workspace_member(workspace_members.workspace_id));

-- Insertion of membership rows is performed by the security-definer signup
-- trigger (which bypasses RLS). No general insert/update/delete policy is
-- defined here for Task 1; workspace invitation flows are out of scope.

-- ---- agents ------------------------------------------------------------
-- Shared within a workspace: any member of agents.workspace_id may
-- select/insert/update/delete. Insert additionally requires the caller to
-- be recorded as created_by.

create policy "agents_select_workspace_member"
  on public.agents for select
  using (
    exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = agents.workspace_id
        and wm.user_id = auth.uid()
    )
  );

create policy "agents_insert_workspace_member"
  on public.agents for insert
  with check (
    created_by = auth.uid()
    and exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = agents.workspace_id
        and wm.user_id = auth.uid()
    )
  );

create policy "agents_update_workspace_member"
  on public.agents for update
  using (
    exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = agents.workspace_id
        and wm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = agents.workspace_id
        and wm.user_id = auth.uid()
    )
  );

create policy "agents_delete_workspace_member"
  on public.agents for delete
  using (
    exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = agents.workspace_id
        and wm.user_id = auth.uid()
    )
  );

-- ---- documents ------------------------------------------------------------
-- Allowed to members of the parent agent's workspace (join agents -> workspace_members).

create policy "documents_select_workspace_member"
  on public.documents for select
  using (
    exists (
      select 1
      from public.agents a
      join public.workspace_members wm on wm.workspace_id = a.workspace_id
      where a.id = documents.agent_id
        and wm.user_id = auth.uid()
    )
  );

create policy "documents_insert_workspace_member"
  on public.documents for insert
  with check (
    exists (
      select 1
      from public.agents a
      join public.workspace_members wm on wm.workspace_id = a.workspace_id
      where a.id = documents.agent_id
        and wm.user_id = auth.uid()
    )
  );

create policy "documents_update_workspace_member"
  on public.documents for update
  using (
    exists (
      select 1
      from public.agents a
      join public.workspace_members wm on wm.workspace_id = a.workspace_id
      where a.id = documents.agent_id
        and wm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.agents a
      join public.workspace_members wm on wm.workspace_id = a.workspace_id
      where a.id = documents.agent_id
        and wm.user_id = auth.uid()
    )
  );

create policy "documents_delete_workspace_member"
  on public.documents for delete
  using (
    exists (
      select 1
      from public.agents a
      join public.workspace_members wm on wm.workspace_id = a.workspace_id
      where a.id = documents.agent_id
        and wm.user_id = auth.uid()
    )
  );

-- ---- chat_sessions ------------------------------------------------------------
-- Private per user: owner only for all operations.

create policy "chat_sessions_select_owner"
  on public.chat_sessions for select
  using (user_id = auth.uid());

create policy "chat_sessions_insert_owner"
  on public.chat_sessions for insert
  with check (user_id = auth.uid());

create policy "chat_sessions_update_owner"
  on public.chat_sessions for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "chat_sessions_delete_owner"
  on public.chat_sessions for delete
  using (user_id = auth.uid());

-- ---- messages ------------------------------------------------------------
-- Private per user via the parent session's user_id.

create policy "messages_select_owner"
  on public.messages for select
  using (
    exists (
      select 1
      from public.chat_sessions cs
      where cs.id = messages.session_id
        and cs.user_id = auth.uid()
    )
  );

create policy "messages_insert_owner"
  on public.messages for insert
  with check (
    exists (
      select 1
      from public.chat_sessions cs
      where cs.id = messages.session_id
        and cs.user_id = auth.uid()
    )
  );

create policy "messages_update_owner"
  on public.messages for update
  using (
    exists (
      select 1
      from public.chat_sessions cs
      where cs.id = messages.session_id
        and cs.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.chat_sessions cs
      where cs.id = messages.session_id
        and cs.user_id = auth.uid()
    )
  );

create policy "messages_delete_owner"
  on public.messages for delete
  using (
    exists (
      select 1
      from public.chat_sessions cs
      where cs.id = messages.session_id
        and cs.user_id = auth.uid()
    )
  );

-- ---- favorites ------------------------------------------------------------
-- Private per user: owner only.

create policy "favorites_select_owner"
  on public.favorites for select
  using (user_id = auth.uid());

create policy "favorites_insert_owner"
  on public.favorites for insert
  with check (user_id = auth.uid());

create policy "favorites_update_owner"
  on public.favorites for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "favorites_delete_owner"
  on public.favorites for delete
  using (user_id = auth.uid());

-- =========================================================================
-- Signup bootstrap trigger: profile + default workspace + admin membership
-- =========================================================================
--
-- security definer + a locked-down search_path let this function bypass RLS
-- for its bootstrap inserts (it runs as the function owner, not the calling
-- user, and unqualified identifiers resolve only within pg_catalog/public/
-- auth to avoid search_path hijacking).

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_name text;
  v_workspace_id uuid;
  v_slug text;
begin
  v_name := coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1));

  insert into public.profiles (id, name, avatar_url, email)
  values (new.id, v_name, new.raw_user_meta_data ->> 'avatar_url', new.email);

  v_slug := lower(regexp_replace(coalesce(split_part(new.email, '@', 1), new.id::text), '[^a-zA-Z0-9]+', '-', 'g'))
            || '-' || substr(new.id::text, 1, 8);

  insert into public.workspaces (name, slug, created_by)
  values (v_name || '''s Workspace', v_slug, new.id)
  returning id into v_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace_id, new.id, 'admin');

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
