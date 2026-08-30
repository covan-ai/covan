-- embedding_width.sql — store vectors of a width other than 1536.
--
-- This is not a migration, and it deliberately does not live in
-- supabase/migrations/. That directory is a linear sequence every Covan runs,
-- including the hosted one, and the number below is not a fact about Covan —
-- it is a fact about the embedding model *you* chose. A migration cannot hold
-- an operator's choice. So this file sits outside the sequence, `migrate`
-- never mounts it (docker-compose.yml mounts ./supabase/migrations only), and
-- nothing applies it unless you do.
--
-- ---------------------------------------------------------------------------
-- WHY YOU WOULD RUN THIS
--
-- Covan embeds with `text-embedding-3-small`, which returns 1536 dimensions,
-- and migration 0004 declared `document_chunks.embedding` as `vector(1536)` to
-- match. Point EMBEDDING_BASE_URL at a local server and you are almost
-- certainly on a different width: nomic-embed-text is 768, mxbai-embed-large
-- and bge-m3 are 1024. pgvector fixes the width at DDL time, so the column, the
-- HNSW index and `match_chunks` all have to move together. This file moves all
-- three.
--
-- ---------------------------------------------------------------------------
-- WHAT IT COSTS: EVERY EMBEDDING YOU HAVE
--
-- A 768-wide vector cannot be stored in a 1536-wide column and cannot be
-- converted into one either — the numbers mean different things, there is no
-- arithmetic that translates between two models' vector spaces. So the stored
-- chunks are deleted, not migrated. Nothing else is: `documents` keeps its
-- rows, its `content`, and its files.
--
-- Full procedure, in order:
--
--   1. Set EMBEDDING_BASE_URL and EMBEDDING_MODEL, and upload one small
--      document. It will fail, and the error names the width the model
--      actually returned. Use that number below rather than a number from a
--      README — several models serve more than one width.
--   2. Edit v_dims here and run this file against your database.
--   3. Set EMBEDDING_DIMENSIONS to the same number and restart the API.
--   4. Re-embed: POST /admin/backfill-embeddings with your ADMIN_API_KEY. It
--      walks every document that has stored text and no chunks, so a second
--      run is safe and only picks up what the first missed.
--   5. Reconsider RAG_MIN_SIMILARITY. It defaults to 0.25, which was chosen
--      against text-embedding-3-small. A different model's scores sit
--      somewhere else, and a floor that is wrong for it does not error — it
--      quietly returns the wrong chunks, or none.
--
-- Step 4 re-embeds from `documents.content`, which every upload stores. A
-- document whose text was never stored — an older row, or a PDF the browser
-- could not extract — is skipped there and needs POST /documents/:id/reindex
-- instead, which re-reads the original file from object storage.
--
-- How long step 4 takes is a function of your endpoint, not of Covan: it is one
-- embedding request per 128 chunks, sequential, and a thousand ordinary
-- documents is on the order of a few thousand chunks. On a local GPU that is
-- minutes. Retrieval is degraded until it finishes — answers fall back to the
-- agent's persona alone, which is what happens today when a document has no
-- chunks, so nothing breaks; it just stops being grounded.
--
-- Run it inside a transaction if your client does not already (`begin;` …
-- `commit;`). The re-embedding in step 4 is the part that cannot be rolled
-- back, and it is deliberately outside this file.
-- ---------------------------------------------------------------------------

do $outer$
declare
  -- The only line to edit. It must equal the width your embedding model
  -- returns, and EMBEDDING_DIMENSIONS must equal it too.
  v_dims constant int := 1536;
  v_current text;
  v_chunks bigint;
begin
  select format_type(atttypid, atttypmod)
    into v_current
    from pg_attribute
   where attrelid = 'public.document_chunks'::regclass
     and attname = 'embedding';

  -- Refusing a no-op matters here more than it usually does: running this file
  -- unchanged would delete every embedding in the database and rebuild the
  -- column exactly as it was, which looks like nothing happened until somebody
  -- asks a question.
  if v_current = format('vector(%s)', v_dims) then
    raise notice 'embedding is already %, nothing to do', v_current;
    return;
  end if;

  select count(*) into v_chunks from public.document_chunks;
  raise notice 'changing % to vector(%), discarding % chunks', v_current, v_dims, v_chunks;

  delete from public.document_chunks;

  -- Dropped rather than left to be rebuilt: an HNSW index is built for a
  -- specific width, and rebuilding it after the column is empty is both correct
  -- and instant.
  drop index if exists public.idx_document_chunks_embedding;

  execute format(
    'alter table public.document_chunks alter column embedding type vector(%s)',
    v_dims
  );

  create index idx_document_chunks_embedding on public.document_chunks
    using hnsw (embedding vector_cosine_ops);

  -- The retrieval function takes the query vector by the same width, so it has
  -- to be replaced too. Body copied from 0005 — if that migration ever changes
  -- this file has to change with it, which is the cost of living outside the
  -- sequence.
  drop function if exists public.match_chunks(uuid, vector, int, float);

  execute format($fmt$
    create function public.match_chunks(
      p_agent_id uuid,
      p_query_embedding vector(%s),
      p_match_count int,
      p_min_similarity float default 0
    )
    returns table (document_id uuid, document_name text, content text, similarity float)
    language sql
    stable
    security invoker
    set search_path = pg_catalog, public
    as $body$
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
    $body$
  $fmt$, v_dims);

  -- Stated rather than inherited, which is what 0023 asked every later change
  -- to do. `security invoker` means document_chunks RLS still decides what
  -- comes back; this only says who may ask.
  execute format(
    'grant execute on function public.match_chunks(uuid, vector(%s), int, float) to authenticated, service_role',
    v_dims
  );

  raise notice 'done — set EMBEDDING_DIMENSIONS=% and run POST /admin/backfill-embeddings', v_dims;
end
$outer$;
