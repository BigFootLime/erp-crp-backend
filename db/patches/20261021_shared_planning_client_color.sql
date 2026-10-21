-- One workshop-wide client color, shared by planning and newly issued OF PDFs.
BEGIN;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS planning_color_hex text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.clients'::regclass AND conname = 'clients_planning_color_hex_ck') THEN
    ALTER TABLE public.clients ADD CONSTRAINT clients_planning_color_hex_ck
      CHECK (planning_color_hex IS NULL OR planning_color_hex ~ '^#[0-9A-F]{6}$');
  END IF;
END $$;
-- Preserve a former personal choice only when every saved choice agrees.
-- Conflicting personal choices remain archived in preferences; no user's choice wins arbitrarily.
WITH agreed AS (
  SELECT entry.key, min(entry.value) AS color
  FROM public.planning_user_preferences pref
  CROSS JOIN LATERAL jsonb_each_text(pref.client_color_overrides) entry
  GROUP BY entry.key HAVING count(DISTINCT entry.value) = 1
)
UPDATE public.clients c SET planning_color_hex = agreed.color
FROM agreed WHERE agreed.key = 'id:' || c.client_id::text
  AND c.planning_color_hex IS NULL AND agreed.color ~ '^#[0-9A-F]{6}$';
COMMENT ON COLUMN public.clients.planning_color_hex IS
  'Shared planning client color; normalized to pastel by the API. NULL uses deterministic palette. OF editions freeze the resolved color.';
COMMIT;
