-- Do not drop the durable requirement or change account policy during rollback.
-- Roll back application binaries and retain this backward-compatible column.
DO $$
BEGIN
  RAISE EXCEPTION 'Retain the additive MFA column during binary rollback; removing it can weaken account protection';
END $$;
