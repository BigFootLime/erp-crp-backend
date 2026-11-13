-- Confirm additive preparation only. Active rows may already belong to an
-- earlier approved cutover; reapplying the patch must preserve their values.
SELECT current_database() AS database_name;
SELECT scope,next_value,active,activated_at,activated_by
FROM public.cutover_business_number_sequences ORDER BY scope;
SELECT entity_code,period_key,next_value,active,activated_at,activated_by
FROM public.cutover_finance_shared_sequences ORDER BY entity_code,period_key;
SELECT (has_table_privilege('cerp_app','public.cutover_business_number_sequences','SELECT')
        AND has_table_privilege('cerp_app','public.cutover_business_number_sequences','UPDATE')) AS business_allocator_granted,
       (has_table_privilege('cerp_app','public.cutover_finance_shared_sequences','SELECT')
        AND has_table_privilege('cerp_app','public.cutover_finance_shared_sequences','INSERT')
        AND has_table_privilege('cerp_app','public.cutover_finance_shared_sequences','UPDATE')) AS financial_allocator_granted,
       has_table_privilege('cerp_app','public.cutover_business_number_sequences','DELETE') AS business_delete_granted,
       has_table_privilege('cerp_app','public.cutover_finance_shared_sequences','TRUNCATE') AS financial_truncate_granted;
