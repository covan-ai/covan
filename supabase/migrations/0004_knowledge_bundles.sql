-- 0004_knowledge_bundles.sql
-- Knowledge Bundles + pgvector RAG.
-- Bundles are workspace-level, attach to agents many-to-many. Documents move
-- from agent-scoped to bundle-scoped. Chunks carry embeddings for retrieval.

create extension if not exists vector;

-- ---- knowledge_bundles ---------------------------------------------------
create table public.knowledge_bundles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  description text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index idx_knowledge_bundles_workspace_id on public.knowledge_bundles (workspace_id);

-- ---- agent_bundles (the plug-in/plug-out link) ---------------------------
create table public.agent_bundles (
  agent_id uuid not null references public.agents (id) on delete cascade,
  bundle_id uuid not null references public.knowledge_bundles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (agent_id, bundle_id)
);
create index idx_agent_bundles_bundle_id on public.agent_bundles (bundle_id);

-- ---- documents: add bundle_id (nullable during backfill) ------------------
alter table public.documents add column bundle_id uuid references public.knowledge_bundles (id) on delete cascade;

-- ---- document_chunks -----------------------------------------------------
create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  bundle_id uuid not null references public.knowledge_bundles (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  chunk_index int not null,
  content text not null,
  embedding vector(1536),
  created_at timestamptz not null default now()
);
create index idx_document_chunks_bundle_id on public.document_chunks (bundle_id);
create index idx_document_chunks_document_id on public.document_chunks (document_id);
create index idx_document_chunks_embedding on public.document_chunks
  using hnsw (embedding vector_cosine_ops);

-- =========================================================================
-- Backfill: move existing agent-scoped documents into a per-agent "Genel"
-- bundle so nothing breaks, then make bundle_id authoritative.
-- =========================================================================
do $$
declare
  a record;
  v_bundle_id uuid;
begin
  for a in
    select distinct d.agent_id, ag.workspace_id, ag.created_by
    from public.documents d
    join public.agents ag on ag.id = d.agent_id
    where d.bundle_id is null
  loop
    insert into public.knowledge_bundles (workspace_id, name, description, created_by)
    values (a.workspace_id, 'General', 'Created automatically (existing documents)', a.created_by)
    returning id into v_bundle_id;

    insert into public.agent_bundles (agent_id, bundle_id)
    values (a.agent_id, v_bundle_id);

    update public.documents
    set bundle_id = v_bundle_id
    where agent_id = a.agent_id and bundle_id is null;
  end loop;
end $$;

-- Now bundle_id is populated for every existing row. Drop the old agent link.
-- The old RLS policies reference agent_id, so they must be dropped BEFORE the
-- column they depend on.
drop policy if exists "documents_select_workspace_member" on public.documents;
drop policy if exists "documents_insert_workspace_member" on public.documents;
drop policy if exists "documents_update_workspace_member" on public.documents;
drop policy if exists "documents_delete_workspace_member" on public.documents;

drop index if exists idx_documents_agent_id;
alter table public.documents drop column agent_id;
alter table public.documents alter column bundle_id set not null;
create index idx_documents_bundle_id on public.documents (bundle_id);

-- =========================================================================
-- RLS
-- =========================================================================
alter table public.knowledge_bundles enable row level security;
alter table public.agent_bundles enable row level security;
alter table public.document_chunks enable row level security;

-- knowledge_bundles: workspace members (insert also requires created_by = self)
create policy "kb_select_member" on public.knowledge_bundles for select
  using (public.is_workspace_member(workspace_id));
create policy "kb_insert_member" on public.knowledge_bundles for insert
  with check (created_by = auth.uid() and public.is_workspace_member(workspace_id));
create policy "kb_update_member" on public.knowledge_bundles for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy "kb_delete_member" on public.knowledge_bundles for delete
  using (public.is_workspace_member(workspace_id));

-- agent_bundles: caller must be a member of the agent's workspace
create policy "ab_select_member" on public.agent_bundles for select
  using (exists (
    select 1 from public.agents a
    where a.id = agent_bundles.agent_id
      and public.is_workspace_member(a.workspace_id)
  ));
create policy "ab_insert_member" on public.agent_bundles for insert
  with check (exists (
    select 1 from public.agents a
    join public.knowledge_bundles b on b.id = agent_bundles.bundle_id
    where a.id = agent_bundles.agent_id
      and a.workspace_id = b.workspace_id
      and public.is_workspace_member(a.workspace_id)
  ));
create policy "ab_delete_member" on public.agent_bundles for delete
  using (exists (
    select 1 from public.agents a
    where a.id = agent_bundles.agent_id
      and public.is_workspace_member(a.workspace_id)
  ));

-- document_chunks: workspace members
create policy "dc_select_member" on public.document_chunks for select
  using (public.is_workspace_member(workspace_id));
create policy "dc_insert_member" on public.document_chunks for insert
  with check (public.is_workspace_member(workspace_id));
create policy "dc_delete_member" on public.document_chunks for delete
  using (public.is_workspace_member(workspace_id));

-- =========================================================================
-- Replace documents RLS: rebase from agent_id onto bundle_id -> workspace
-- (old agent_id-based policies were already dropped above, before the column)
-- =========================================================================
create policy "documents_select_member" on public.documents for select
  using (exists (
    select 1 from public.knowledge_bundles b
    where b.id = documents.bundle_id and public.is_workspace_member(b.workspace_id)
  ));
create policy "documents_insert_member" on public.documents for insert
  with check (exists (
    select 1 from public.knowledge_bundles b
    where b.id = documents.bundle_id and public.is_workspace_member(b.workspace_id)
  ));
create policy "documents_update_member" on public.documents for update
  using (exists (
    select 1 from public.knowledge_bundles b
    where b.id = documents.bundle_id and public.is_workspace_member(b.workspace_id)
  ))
  with check (exists (
    select 1 from public.knowledge_bundles b
    where b.id = documents.bundle_id and public.is_workspace_member(b.workspace_id)
  ));
create policy "documents_delete_member" on public.documents for delete
  using (exists (
    select 1 from public.knowledge_bundles b
    where b.id = documents.bundle_id and public.is_workspace_member(b.workspace_id)
  ));

-- =========================================================================
-- Retrieval RPC — top-k chunks across the bundles attached to an agent.
-- SECURITY INVOKER: document_chunks RLS is the isolation backstop.
-- =========================================================================
create function public.match_chunks(
  p_agent_id uuid,
  p_query_embedding vector(1536),
  p_match_count int
)
returns table (document_id uuid, document_name text, content text, similarity float)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select dc.document_id,
         d.name as document_name,
         dc.content,
         1 - (dc.embedding <=> p_query_embedding) as similarity
  from public.document_chunks dc
  join public.documents d on d.id = dc.document_id
  where dc.embedding is not null
    and dc.bundle_id in (
      select ab.bundle_id from public.agent_bundles ab where ab.agent_id = p_agent_id
    )
  order by dc.embedding <=> p_query_embedding
  limit p_match_count;
$$;
