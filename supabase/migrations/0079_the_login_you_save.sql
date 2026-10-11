-- The login you save: a site's username and password, encrypted, kept for one
-- agent so its browser can sign in without asking every time.
--
-- 0077 made a login wall recoverable by handing the person the browser: they
-- sign in with their own hands and the cookie jar remembers. That covers the
-- person who is there. It does not cover the run nobody is watching -- a
-- routine at nine in the morning, a colleague asking the agent something on a
-- site the jar has been logged out of -- and it does not cover the login a
-- team shares on purpose: the sales account, the supplier portal everybody
-- orders through. This table is where such a login is kept, and the only
-- thing in this product that holds a password a person typed for a site.
--
-- ---------------------------------------------------------------------------
-- WHY TWO SCOPES, AND WHY THE ROW ALWAYS HAS AN OWNER.
--
-- `scope = 'owner'` is a login somebody saved for themselves: used only when
-- they are the one the agent is working for, and seen by nobody else. It is
-- the same standing as 0077's jar, and the read policy's first branch is the
-- jar's policy exactly.
--
-- `scope = 'agent'` is a login saved FOR the agent: used whoever is asking,
-- and therefore visible -- by label, never by value -- to everybody who may
-- use that agent, so that a colleague can see which account the agent is
-- going to sign in as before it does. "May use the agent" is not a new rule:
-- it is `agents_select_workspace_member` (0040), reproduced below.
--
-- Either way `user_id` says who saved it. Deleting their ACCOUNT deletes
-- their logins, through `on delete cascade` from `auth.users`. Leaving the
-- WORKSPACE deletes nothing (ruling R29): their own logins stay theirs, and a
-- shared one becomes unusable -- `lib/browser/credentials.ts` binds a
-- `scope = 'agent'` row to a run only while its saver is still a member of
-- the row's workspace -- until the saver or a workspace admin removes it. A
-- shared login is still somebody's password, and the agent must not keep
-- signing in with it after that somebody has gone; but deleting a row because
-- a membership changed would throw away a password a re-invited person would
-- have to type again, so the library refuses to use it instead.
--
-- ---------------------------------------------------------------------------
-- WHY THE USERNAME IS CIPHERTEXT TOO, AND WHY NEITHER CIPHERTEXT IS GRANTED.
--
-- 0059's argument about `tool_connections.secret_ciphertext`, and 0046's
-- about `workspace_provider_keys`: the ciphertexts open only under an
-- operator secret (`secret-box.ts`'s envelope, the one format this product
-- encrypts with) that never reaches a client, so a client holding them gains
-- nothing it should have and an exposed column is a column somebody will
-- later build a screen on. Both are granted to no client role.
--
-- The username is encrypted rather than stored beside the label because it is
-- half the credential and frequently the more personal half -- an email
-- address, a personal phone number -- and a shared login's row is readable by
-- every member who uses the agent. `label` is what a screen shows ("LinkedIn
-- -- sales account"), and it is the person's own words about the login, never
-- the login itself. There is no plaintext username column at all, so no future
-- grant can open one by mistake; `browser-credentials.test.ts` pins the full
-- column list for that reason.
--
-- ---------------------------------------------------------------------------
-- WHY NO CLIENT ROLE CAN WRITE IT.
--
-- No insert, update or delete grant, and no write policy, for anon or
-- authenticated. Saving a login means encrypting it, which only the worker can
-- do, so `lib/browser/credentials.ts` writes through the service role after
-- the route has checked, through the caller's own client, that the caller may
-- use the agent. Deletion takes the same road and the same rule is enforced
-- there rather than here: the person who saved a login may always delete it,
-- and a workspace admin may also delete a `scope = 'agent'` one -- a shared
-- login is the team's to stop using even when its saver is away. An admin may
-- NOT delete somebody's own login, because an admin cannot see it either.
--
-- ---------------------------------------------------------------------------
-- WHY `site_host` IS A BARE LOWERCASE HOST, AND THE TWO UNIQUE INDEXES.
--
-- The run binding (2.3) matches a saved login to the site a run is on, and
-- hands browser-use the host as `allowedDomains` -- the shape that list
-- wants, and the same check 0078 put on `browser_tasks.signin_host`. A pasted
-- URL, a capital or a space would make a login that never matches anything,
-- so the worker normalises before it writes and this refuses what it missed.
--
-- Two partial unique indexes rather than one table-level unique (ruling R28),
-- because the two scopes are counted differently:
--
--   `browser_credentials_agent_site_idx`, `(agent_id, site_host) where
--   scope = 'agent'`: ONE shared login per site per agent, whoever saved it.
--   A unique that included `user_id` would let two members each save a shared
--   login for the same site, and the run binding would have two accounts to
--   choose between with nothing to choose by.
--
--   `browser_credentials_owner_site_idx`, `(agent_id, user_id, site_host)
--   where scope = 'owner'`: one personal login per person per site per agent.
--   Two members may each keep their own for the same site; that is what a
--   personal login is.
--
-- Nothing stops the same person holding one of each for a site -- their own
-- account and the team's -- and the binding prefers the caller's own, which is
-- the case the scope column exists for.

create table if not exists public.browser_credentials (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  -- Who saved it; their account's deletion takes it. See the header.
  user_id uuid not null references auth.users (id) on delete cascade,
  scope text not null check (scope in ('owner', 'agent')),
  -- Bare host, as allowedDomains wants. See the header.
  site_host text not null check (site_host = lower(site_host) and site_host !~ '[/:@\s]'),
  -- "LinkedIn -- sales account"; never the username.
  label text not null,
  -- Never handed to a client. See the header.
  username_ciphertext text not null,
  password_ciphertext text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

comment on table public.browser_credentials is
  'A site login saved for one agent, encrypted (0079): scope owner is the '
  'saver''s own, scope agent is used for everybody who may use the agent. '
  'Written and deleted only by the worker through the service role.';

comment on column public.browser_credentials.username_ciphertext is
  'The username, encrypted. Withheld from every client role for '
  'secret_ciphertext''s reason (0059): it opens only under an operator secret, '
  'and a shared login''s row is readable by every member who uses the agent.';

comment on column public.browser_credentials.password_ciphertext is
  'The password, encrypted. Withheld from every client role.';

comment on column public.browser_credentials.label is
  'The saver''s own words for the login, shown on screens. Never the username.';

-- One shared login per site per agent. See the header.
create unique index if not exists browser_credentials_agent_site_idx
  on public.browser_credentials (agent_id, site_host)
  where scope = 'agent';

-- One personal login per person per site per agent. See the header.
create unique index if not exists browser_credentials_owner_site_idx
  on public.browser_credentials (agent_id, user_id, site_host)
  where scope = 'owner';

-- The read policy's first branch, and the `on delete cascade` from
-- `auth.users`: both look a person's logins up by `user_id`, which neither
-- unique index (both lead with `agent_id`) serves.
create index if not exists browser_credentials_user_idx
  on public.browser_credentials (user_id);

alter table public.browser_credentials enable row level security;

-- The saver always sees their own row, in any scope -- it is their login, and
-- the screen that deletes it has to be able to find it. 0077's jar policy
-- exactly, for 0077's reason.
--
-- Anybody else sees a `scope = 'agent'` row only if they are a member of its
-- workspace AND may use its agent. The agent half is
-- `agents_select_workspace_member` as 0040 last defined it -- `deleted_at is
-- null and public.is_workspace_member(workspace_id)` on the agent row --
-- reproduced here exactly, because it is an inline predicate rather than a
-- function to call. (The subquery also runs under the caller's own policy on
-- `agents`, so the two can only agree; spelling it out keeps this policy
-- honest if that one is ever widened.) An agent in the trash therefore takes
-- its shared logins out of sight with it, and a restore brings them back.
drop policy if exists "browser_credentials_read" on public.browser_credentials;
create policy "browser_credentials_read"
  on public.browser_credentials for select
  using (
    user_id = auth.uid()
    or (
      scope = 'agent'
      and public.is_workspace_member(workspace_id)
      and exists (
        select 1 from public.agents a
        where a.id = browser_credentials.agent_id
          and a.deleted_at is null
          and public.is_workspace_member(a.workspace_id)
      )
    )
  );

revoke all on public.browser_credentials from anon, authenticated;
-- What a screen needs to list the logins and nothing else: whose, for which
-- agent, which site, what it is called, and when it was last used. Both
-- ciphertexts are withheld for the header's reasons.
grant select (
  id, workspace_id, agent_id, user_id, scope, site_host, label, created_at, last_used_at
) on public.browser_credentials to authenticated;
-- 0023's closing rule: a migration that adds a table grants for it, in the
-- same file.
grant select, insert, update, delete on public.browser_credentials to service_role;

-- ---- browser_tasks.credential_id (ruling R32) -------------------------------
-- Which saved login a run CARRIED, or null. Written by `recordBrowserTask`
-- when `browse` handed the run `credentialsFor`'s bindings, and read by
-- nothing but `deliver.ts`, for one sentence.
--
-- The sentence is "the saved login for linkedin.com did not work -- update
-- it?", and it is only true of a login the run was actually given. A login
-- that is merely SAVED for the site was never tried when the model named no
-- `site`, when a hand-back re-ran the task without it, or when `site` named
-- another host than the one that walled the run; telling the person to
-- re-enter a password that is correct sends them round the same wall again.
-- `hasSavedCredential` can say a login exists; only the run can say it carried
-- one, so the run writes it down.
--
-- `on delete set null` for `retry_of`'s reason (0077): forgetting a login must
-- not take the record of what was asked with it, and a task whose login has
-- been forgotten since has nothing left to blame -- deliver then asks for a
-- sign-in, which is right.
--
-- Granted to NO client role. 0073 names `browser_tasks`' selectable columns
-- one by one, so a new column is withheld until a migration says otherwise,
-- and this one does not: the panel and the task card have no use for it, and
-- an id naming a row of this table is not something a screen should start
-- depending on. `browser-tasks.test.ts` pins the 42501.
alter table public.browser_tasks
  add column if not exists credential_id uuid
    references public.browser_credentials (id) on delete set null;

comment on column public.browser_tasks.credential_id is
  'The saved login (browser_credentials) this run carried as secret bindings, '
  'or null (0079, R32). Read only by the worker, so deliver says "the saved '
  'login did not work" only of a login the run was given. No client grant.';

-- Forgetting a login sets this null on every task that carried it; without
-- an index that is a scan of every browser task ever run, per Forget. Partial,
-- because most runs carry no login.
create index if not exists browser_tasks_credential_idx
  on public.browser_tasks (credential_id)
  where credential_id is not null;
