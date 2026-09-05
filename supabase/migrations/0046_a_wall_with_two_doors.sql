-- A workspace's own provider keys, for the tokens past its members' allowance.
--
-- Every other table in this schema answers "who may see this row" with a policy.
-- This one answers it with the absence of a way in. RLS is enabled and NO policy
-- is written for `authenticated`, so PostgREST has nothing to match: the
-- workspace's own admin selects nothing. That is deliberate and it is the point.
-- A policy narrow enough to be safe here would still hand a live credential to
-- whoever could forge the conditions it tests, and the credential bills somebody
-- else's OpenAI account.
--
-- The Worker is the only reader, through `service_role`, and it checks the admin
-- role itself before writing. `tests/rls/provider-keys.test.ts` holds this down.

create table public.workspace_provider_keys (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,

  -- AES-256-GCM under PROVIDER_KEY_SECRET, base64. The IV is per-encryption and
  -- is not a secret; it is stored beside what it opens because it has to be.
  openai_ciphertext text,
  openai_iv text,
  -- "sk-…4f2a". The only part of a key that ever leaves the Worker, so that an
  -- admin can recognise which key is set without being handed it back.
  openai_hint text,

  anthropic_ciphertext text,
  anthropic_iv text,
  anthropic_hint text,

  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),

  -- A half-written key is a key that fails at the worst moment: mid-reply, for
  -- somebody who has already run out of allowance. Ciphertext, IV and hint
  -- arrive together or not at all.
  constraint openai_complete check (
    (openai_ciphertext is null and openai_iv is null and openai_hint is null)
    or (openai_ciphertext is not null and openai_iv is not null and openai_hint is not null)
  ),
  constraint anthropic_complete check (
    (anthropic_ciphertext is null and anthropic_iv is null and anthropic_hint is null)
    or (anthropic_ciphertext is not null and anthropic_iv is not null and anthropic_hint is not null)
  )
);

alter table public.workspace_provider_keys enable row level security;

-- Written out rather than left to inherit from an earlier blanket grant.
-- `0045_the_grant_0043_forgot.sql` exists because that inference was made once.
revoke all on public.workspace_provider_keys from anon, authenticated;
grant select, insert, update, delete on public.workspace_provider_keys to service_role;
