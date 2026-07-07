# db/privileged — superuser-only database migrations

These SQL files are **NOT** part of the normal `db/patches` pipeline.

`npm run db:patches:up` connects as the **application role** (`cerp_app`, via `DATABASE_URL`)
and only reads `db/patches/*.sql`. The migrations here require a **PostgreSQL superuser**
(`postgres`) because they change table ownership, grants, or other privileged objects that
the app role cannot (and must not) perform.

## How to apply

```bash
# On the atelier host (HYPERBOX2), via peer auth as the postgres superuser:
sudo -u postgres psql -d cerp_test -f db/privileged/<file>.sql   # validate first
sudo -u postgres psql -d cerp_prod -f db/privileged/<file>.sql   # prod, after validation
```

Each migration:
- refuses to run if `current_user` is not a superuser (guard at the top);
- is idempotent and non-destructive (no row changed/deleted);
- ships with a `*.rollback.sql` and a `*.verify.sql` next to it.

Always take a backup first: `sudo /usr/local/sbin/cerp-pg-backup.sh`.

## Inventory

| File | Purpose | ISO / CAPA |
|---|---|---|
| `20260707_erp_audit_logs_append_only.sql` | Make `erp_audit_logs` append-only for `cerp_app` (ownership off the app role + INSERT/SELECT-only grants + append-only trigger) | A.8.15 / CA-SEC-03 |
| `20260707_users_view_minimal.sql` | Recreate `users_view` without sensitive columns (drop `password`/`salary`/`national_id`/`date_of_birth`/address/…); keep standard-admin fields + derived `is_minor`; owner→`postgres`, `cerp_app` SELECT-only | A.8.24 / A.5.34 / CA-RGPD-07 |
