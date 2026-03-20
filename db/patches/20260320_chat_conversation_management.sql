-- 20260320_chat_conversation_management.sql
-- Internal ERP chat: conversation management (archive/delete-for-me).
-- Idempotent patch: safe to run multiple times.

BEGIN;

ALTER TABLE public.chat_conversation_participants
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

COMMIT;
