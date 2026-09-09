# Recovery — distinct needs and receipt destination

Keep additive columns and both unique indexes when rolling back application code.
Do not restore the former OF-wide unique index while several active needs share
one lot: reconcile their canonical reservations first. Never delete reservations
or stock movements to make an old index fit. Backup is required before applying.

Test database: cerp_test. No stock balance is modified by this patch.
