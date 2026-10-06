-- Roll back application binaries using the release pointer; retain initial ARs,
-- revisions and shipment evidence. Never delete this industrial history.
SELECT count(*) AS retained_initial_promises FROM public.delivery_promise_roots;
