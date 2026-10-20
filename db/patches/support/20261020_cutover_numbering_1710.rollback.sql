-- Before activation: roll back the application while retaining inactive
-- additive proposals. Never reset a sequence as part of an ordinary update.
-- After activation: use only an application version compatible with the new
-- numbering. A legacy generator must not resume the same document series.
SELECT current_database() AS database_name,
       CASE WHEN EXISTS (SELECT 1 FROM public.cutover_business_number_sequences WHERE active)
                  OR EXISTS (SELECT 1 FROM public.cutover_finance_shared_sequences WHERE active)
            THEN 'REQUIRE_APPLICATION_COMPATIBLE_WITH_ACTIVE_NUMBERING'
            ELSE 'KEEP_INACTIVE_PROPOSALS_AND_ROLL_BACK_APPLICATION'
       END AS rollback_action;
