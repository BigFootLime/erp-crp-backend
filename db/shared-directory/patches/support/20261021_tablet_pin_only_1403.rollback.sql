-- Non-destructive rollback guidance for TABLET-PIN-ONLY-20261021.
-- Keep the additive lookup columns. Roll back only to a qualified runtime that
-- preserves PIN-v2; otherwise disable tablet PIN and use password/MFA.
-- Dropping them loses rotation/reconfiguration state and can re-enable unsafe
-- assumptions. No DDL or DML is intentionally performed.
SELECT true AS application_rollback_only;
