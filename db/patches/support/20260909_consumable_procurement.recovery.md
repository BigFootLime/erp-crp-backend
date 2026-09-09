# Recovery — consommable procurement #1047

Run the standard database backup before applying. The verification script reads as `cerp_app`.
No stock quantity or historical article is rewritten by this migration.

Prefer an additive correction. Do not drop the command or admission ledgers once they contain business records.
Rolling back the application also requires disabling the new write routes: old code treats null draft prices as zero and does not recognize receipt admissions.
Restoring NOT NULL is possible only after each unknown price has been explicitly completed or its draft dealt with; never mass-fill zero.
Removing the new reconciliation column requires no consumable revision links, then restoring the original command constraint.
Full restoration from backup must be coordinated to avoid losing transactions recorded since the backup.
