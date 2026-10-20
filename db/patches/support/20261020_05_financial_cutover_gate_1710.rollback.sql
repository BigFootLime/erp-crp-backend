-- Never drop the guard or reset a fiscal/proforma sequence during an ordinary
-- rollback. PREPARING and ACTIVE require an application version containing the
-- guard: an earlier backend could allocate a legacy proforma number unaware of
-- the durable suspension.
SELECT current_database() AS database_name,
       phase,
       CASE phase
         WHEN 'IDLE' THEN 'APPLICATION_ROLLBACK_ALLOWED_KEEP_GATE'
         ELSE 'REQUIRE_BACKEND_WITH_FINANCIAL_CUTOVER_GUARD'
       END AS rollback_action
FROM public.financial_cutover_gate;
