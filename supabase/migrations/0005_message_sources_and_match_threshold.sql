-- =========================================================================
-- Real citations + retrieval similarity floor
--
-- 1. messages.sources — persists which documents actually grounded an
--    assistant reply, so the chat UI can show trustworthy citations that
--    survive a reload (replacing the old client-side hash-based fake).
-- 2. match_chunks gains p_min_similarity — a cosine-similarity floor so an
--    off-topic question no longer injects the 8 nearest-but-irrelevant chunks
--    into the prompt. Defaults to 0 (old behavior) for safety.
-- =========================================================================

alter table public.messages add column if not exists sources jsonb;

-- Replace the retrieval function with a version that takes a similarity floor.
-- Signature changes (extra arg), so drop the old one first.
drop function if exists public.match_chunks(uuid, vector, int);

create function public.match_chunks(
  p_agent_id uuid,
  p_query_embedding vector(1536),
  p_match_count int,
  p_min_similarity float default 0
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
    and (1 - (dc.embedding <=> p_query_embedding)) >= p_min_similarity
    and dc.bundle_id in (
      select ab.bundle_id from public.agent_bundles ab where ab.agent_id = p_agent_id
    )
  order by dc.embedding <=> p_query_embedding
  limit p_match_count;
$$;
