-- 20260319_chat_groups.sql
-- Internal ERP chat: add group conversations.
-- Idempotent patch: safe to run multiple times.

BEGIN;

ALTER TABLE public.chat_conversations
  ADD COLUMN IF NOT EXISTS group_name TEXT NULL;

ALTER TABLE public.chat_conversations
  ADD COLUMN IF NOT EXISTS created_by INTEGER NULL;

ALTER TABLE public.chat_conversations
  DROP CONSTRAINT IF EXISTS chat_conversations_type_check;

ALTER TABLE public.chat_conversations
  ADD CONSTRAINT chat_conversations_type_check
  CHECK (type IN ('direct', 'group'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_conversations_group_name_check'
      AND conrelid = 'public.chat_conversations'::regclass
  ) THEN
    ALTER TABLE public.chat_conversations
      ADD CONSTRAINT chat_conversations_group_name_check
      CHECK (
        type <> 'group'
        OR length(btrim(COALESCE(group_name, ''))) > 0
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_conversations_group_direct_ids_null_check'
      AND conrelid = 'public.chat_conversations'::regclass
  ) THEN
    ALTER TABLE public.chat_conversations
      ADD CONSTRAINT chat_conversations_group_direct_ids_null_check
      CHECK (
        type <> 'group'
        OR (direct_user_low_id IS NULL AND direct_user_high_id IS NULL)
      );
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_conversations_created_by_fkey'
      AND conrelid = 'public.chat_conversations'::regclass
  ) THEN
    ALTER TABLE public.chat_conversations
      ADD CONSTRAINT chat_conversations_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS chat_conversations_group_name_search_idx
ON public.chat_conversations (lower(group_name))
WHERE group_name IS NOT NULL;

COMMIT;



