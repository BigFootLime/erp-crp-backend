-- One workshop-wide client color, shared by planning and newly issued OF PDFs.
-- Backfill is intentionally performed only when this column is first created:
-- replaying the patch must never turn an explicit later reset (NULL) into an old color.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.clients'::regclass
      AND attname = 'planning_color_hex' AND NOT attisdropped
  ) THEN
    ALTER TABLE public.clients ADD COLUMN planning_color_hex text;

    -- The historic client value was already common to the workshop. Preserve it
    -- before considering former individual preferences. to_jsonb keeps this
    -- compatible with older schemas where either legacy column is absent.
    IF to_regclass('public.planning_user_preferences') IS NULL THEN
      UPDATE public.clients c
      SET planning_color_hex = COALESCE(
        CASE WHEN upper(btrim(to_jsonb(c)->>'color_hex')) ~ '^#[0-9A-F]{6}$' THEN upper(btrim(to_jsonb(c)->>'color_hex')) END,
        CASE WHEN upper(btrim(to_jsonb(c)->>'color')) ~ '^#[0-9A-F]{6}$' THEN upper(btrim(to_jsonb(c)->>'color')) END
      );
    ELSE
      WITH agreed AS (
        SELECT entry.key, min(upper(btrim(entry.value))) AS color
        FROM public.planning_user_preferences pref
        CROSS JOIN LATERAL jsonb_each_text(pref.client_color_overrides) entry
        GROUP BY entry.key
        HAVING bool_and(upper(btrim(entry.value)) ~ '^#[0-9A-F]{6}$')
           AND count(DISTINCT upper(btrim(entry.value))) = 1
      )
      UPDATE public.clients c
      SET planning_color_hex = COALESCE(
        CASE WHEN upper(btrim(to_jsonb(c)->>'color_hex')) ~ '^#[0-9A-F]{6}$' THEN upper(btrim(to_jsonb(c)->>'color_hex')) END,
        CASE WHEN upper(btrim(to_jsonb(c)->>'color')) ~ '^#[0-9A-F]{6}$' THEN upper(btrim(to_jsonb(c)->>'color')) END,
        (SELECT agreed.color FROM agreed WHERE agreed.key = 'id:' || c.client_id::text)
      );
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.clients'::regclass AND conname = 'clients_planning_color_hex_ck') THEN
    ALTER TABLE public.clients ADD CONSTRAINT clients_planning_color_hex_ck
      CHECK (planning_color_hex IS NULL OR planning_color_hex ~ '^#[0-9A-F]{6}$');
  END IF;
END $$;
COMMENT ON COLUMN public.clients.planning_color_hex IS
  'Shared planning client color; normalized to pastel by the API. NULL uses deterministic palette. OF editions freeze the resolved color.';
COMMIT;
