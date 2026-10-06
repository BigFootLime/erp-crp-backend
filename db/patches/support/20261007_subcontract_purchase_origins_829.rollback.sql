-- Restore the previous application release. Keep additive origin proofs and
-- canonical supplier orders/stock movements. No industrial history is deleted.
SELECT count(*) AS preserved_origin_proofs FROM public.subcontract_purchase_origins;
