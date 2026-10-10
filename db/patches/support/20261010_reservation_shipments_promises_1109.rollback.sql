-- Roll runtime back only. Shipment evidence and reconciliation journal are retained.
-- The immutable records support historical delivery metrics; deleting them is unsafe.
SELECT status,count(*) AS retained_records FROM public.delivery_promise_shipment_reconciliations GROUP BY status;
