-- 20260318_chat_internal_messaging.sql
-- Internal ERP chat (direct 1-to-1 conversations).
-- Idempotent patch: safe to run multiple times.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 1) Conversations                                                           */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.chat_conversations (
  id UUID NOT NULL,
  type TEXT NOT NULL DEFAULT 'direct',
  direct_user_low_id INTEGER NULL,
  direct_user_high_id INTEGER NULL,
  last_message_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chat_conversations_pkey PRIMARY KEY (id)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') THEN
    EXECUTE 'ALTER TABLE public.chat_conversations ALTER COLUMN id SET DEFAULT gen_random_uuid()';
  ELSIF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uuid_generate_v4') THEN
    EXECUTE 'ALTER TABLE public.chat_conversations ALTER COLUMN id SET DEFAULT uuid_generate_v4()';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_conversations_type_check'
      AND conrelid = 'public.chat_conversations'::regclass
  ) THEN
    ALTER TABLE public.chat_conversations
      ADD CONSTRAINT chat_conversations_type_check
      CHECK (type IN ('direct'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_conversations_direct_pair_check'
      AND conrelid = 'public.chat_conversations'::regclass
  ) THEN
    ALTER TABLE public.chat_conversations
      ADD CONSTRAINT chat_conversations_direct_pair_check
      CHECK (
        type <> 'direct'
        OR (
          direct_user_low_id IS NOT NULL
          AND direct_user_high_id IS NOT NULL
          AND direct_user_low_id < direct_user_high_id
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_conversations_direct_pair_uniq'
      AND conrelid = 'public.chat_conversations'::regclass
  ) THEN
    ALTER TABLE public.chat_conversations
      ADD CONSTRAINT chat_conversations_direct_pair_uniq
      UNIQUE (type, direct_user_low_id, direct_user_high_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS chat_conversations_last_message_at_idx
ON public.chat_conversations (last_message_at DESC)
WHERE last_message_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_conversations_updated_at_idx
ON public.chat_conversations (updated_at DESC);

DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_conversations_direct_user_low_fkey'
      AND conrelid = 'public.chat_conversations'::regclass
  ) THEN
    ALTER TABLE public.chat_conversations
      ADD CONSTRAINT chat_conversations_direct_user_low_fkey
      FOREIGN KEY (direct_user_low_id) REFERENCES public.users(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_conversations_direct_user_high_fkey'
      AND conrelid = 'public.chat_conversations'::regclass
  ) THEN
    ALTER TABLE public.chat_conversations
      ADD CONSTRAINT chat_conversations_direct_user_high_fkey
      FOREIGN KEY (direct_user_high_id) REFERENCES public.users(id) ON DELETE CASCADE;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 2) Participants                                                             */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.chat_conversation_participants (
  id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  user_id INTEGER NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_at TIMESTAMPTZ NULL,
  CONSTRAINT chat_conversation_participants_pkey PRIMARY KEY (id)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') THEN
    EXECUTE 'ALTER TABLE public.chat_conversation_participants ALTER COLUMN id SET DEFAULT gen_random_uuid()';
  ELSIF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uuid_generate_v4') THEN
    EXECUTE 'ALTER TABLE public.chat_conversation_participants ALTER COLUMN id SET DEFAULT uuid_generate_v4()';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS chat_conversation_participants_conv_user_uniq
ON public.chat_conversation_participants (conversation_id, user_id);

CREATE INDEX IF NOT EXISTS chat_conversation_participants_user_idx
ON public.chat_conversation_participants (user_id);

CREATE INDEX IF NOT EXISTS chat_conversation_participants_conversation_idx
ON public.chat_conversation_participants (conversation_id);

DO $$
BEGIN
  IF to_regclass('public.chat_conversations') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_conversation_participants_conversation_fkey'
      AND conrelid = 'public.chat_conversation_participants'::regclass
  ) THEN
    ALTER TABLE public.chat_conversation_participants
      ADD CONSTRAINT chat_conversation_participants_conversation_fkey
      FOREIGN KEY (conversation_id) REFERENCES public.chat_conversations(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_conversation_participants_user_fkey'
      AND conrelid = 'public.chat_conversation_participants'::regclass
  ) THEN
    ALTER TABLE public.chat_conversation_participants
      ADD CONSTRAINT chat_conversation_participants_user_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 3) Messages                                                                 */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.chat_messages (
  id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  sender_user_id INTEGER NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ NULL,
  CONSTRAINT chat_messages_pkey PRIMARY KEY (id)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') THEN
    EXECUTE 'ALTER TABLE public.chat_messages ALTER COLUMN id SET DEFAULT gen_random_uuid()';
  ELSIF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uuid_generate_v4') THEN
    EXECUTE 'ALTER TABLE public.chat_messages ALTER COLUMN id SET DEFAULT uuid_generate_v4()';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS chat_messages_conversation_created_idx
ON public.chat_messages (conversation_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS chat_messages_sender_idx
ON public.chat_messages (sender_user_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_messages_type_check'
      AND conrelid = 'public.chat_messages'::regclass
  ) THEN
    ALTER TABLE public.chat_messages
      ADD CONSTRAINT chat_messages_type_check
      CHECK (message_type IN ('text'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_messages_content_not_blank_check'
      AND conrelid = 'public.chat_messages'::regclass
  ) THEN
    ALTER TABLE public.chat_messages
      ADD CONSTRAINT chat_messages_content_not_blank_check
      CHECK (length(btrim(content)) > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.chat_conversations') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_messages_conversation_fkey'
      AND conrelid = 'public.chat_messages'::regclass
  ) THEN
    ALTER TABLE public.chat_messages
      ADD CONSTRAINT chat_messages_conversation_fkey
      FOREIGN KEY (conversation_id) REFERENCES public.chat_conversations(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_messages_sender_fkey'
      AND conrelid = 'public.chat_messages'::regclass
  ) THEN
    ALTER TABLE public.chat_messages
      ADD CONSTRAINT chat_messages_sender_fkey
      FOREIGN KEY (sender_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
  END IF;
END $$;

COMMIT;
