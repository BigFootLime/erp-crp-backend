# Recovery — grouped supplier receipts #1047

Back up before migration. Existing orders and receipts retain NULL policy/confirmation columns, so their history is unchanged.
Disable grouped receipt routes before rolling back the application. Do not delete confirmed receipts, their lines, BL files or stock movements.
Prefer additive fixes. A schema rollback is only safe before any new workflow data exists; otherwise preserve these columns and the command history.
If a transaction fails, its official quantities roll back together. An empty prepared header and uploaded BL may remain for retry; they are not a receipt of stock.
