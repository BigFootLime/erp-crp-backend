# Database Patches

CERP stores SQL patch files in `db/patches/`. The local-first production
database is PostgreSQL on HYPERBOX2, database `cerp_prod`.

Do not make schema changes directly on the VPS. The VPS must not become a
second writable database.

## Commands

Show patch status:

```bash
npm run db:patches:status
```

Preview pending patches without changing the database:

```bash
npm run db:patches:up -- --dry-run
```

Apply pending patches to the local database:

```bash
npm run db:patches:up
```

Record the current patch set as already applied without executing SQL:

```bash
npm run db:patches:baseline -- --dry-run
npm run db:patches:baseline
```

Use `baseline` only after confirming the restored database already contains the
schema represented by the current patch files.

## Rules

- Before any database change, download or retrieve the latest SQL backup from
  the VPS/Coolify backup system first.
- Keep a local PostgreSQL backup as an additional safety net, but do not treat
  it as a replacement for the VPS/Coolify backup requested for CERP DB work.
- Prefer additive SQL changes.
- Do not edit a patch file after it has been applied; add a new patch instead.
- Review `checksum-mismatch` results before continuing.
- Keep passwords and `DATABASE_URL` out of Git, logs, and tickets.
