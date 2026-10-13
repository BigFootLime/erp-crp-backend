-- A used cancellation is immutable evidence. Roll forward rather than delete
-- its record or run an older application that does not understand CANCELLED.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.quality_control WHERE status::text='CANCELLED')
    THEN RAISE EXCEPTION '1276 cancellation is used: preserve evidence and roll forward'; END IF;
END $$;
-- On a pristine installation, retaining the additive columns, unused enum
-- label and guards is safe. No historical data or existing constraint is removed.
