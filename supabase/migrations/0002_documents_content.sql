-- Phase 3: store a bounded extracted-text excerpt per document, populated at
-- upload time and read by the chat endpoint to ground replies in real content.
-- Existing rows keep content = null (chat degrades to name-only).
-- RLS: no new policies needed — documents_*_workspace_member already gate the row.
alter table public.documents add column content text;
