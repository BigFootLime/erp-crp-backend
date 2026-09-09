# Recovery — consommables #1047

Back up cerp_test before applying. Apply the schema before the API and UI.
No existing article is reclassified. Existing quality requirements stay enabled.
Rollback means disabling the new entry points while retaining the columns,
category and immutable stock/purchase/reception history. Do not drop data or
replay a stock command under a different key after an uncertain response.
Production activation is a separate release decision after test acceptance.
