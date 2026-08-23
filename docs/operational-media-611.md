# Operational media contract (#611)

Private machine, client-logo and outillage image/PDF files are no longer available from
`/images`. API DTOs expose an opaque, randomly allocated UUID in an
`*_asset: { asset_id, status }` reference; they do not expose a storage path,
filename, URL or bearer capability.

The frontend must fetch `GET /api/v1/operational-media/:assetId/content` with
its normal `Authorization: Bearer <JWT>` header, convert the successful blob to
an object URL locally, and revoke that object URL when the component unloads.
Use `?download=1` for attachment semantics. Query
`GET /api/v1/operational-media/capabilities` before enabling media actions.

The endpoint rechecks the current owner module grant for every request. This ERP
uses module-wide visibility (not per-record tenancy): a user granted `production`,
`clients`, `fournisseurs` or `outillage` may read active media bound to an
existing record in that module. Chat/profile pictures are readable by any
authenticated active user. Unknown or out-of-scope assets return `404`; revoked
assets return `410`; quarantined assets return `423`. Before any bytes are sent, the endpoint must durably write
an `OPERATIONAL_MEDIA_READ_AUTHORIZED` receipt; an audit outage therefore fails
the request closed. A finished response additionally attempts an
`OPERATIONAL_MEDIA_READ_COMPLETED` receipt. An aborted response deliberately
has no completion receipt. Completion persistence is post-response best effort:
if it fails, the client cannot be told retroactively, so an operational error is
logged for alerting rather than falsely claiming a completed audit.

## Legacy verification and recovery

Backfilled files start as `LEGACY_UNVERIFIED` and are never projected or
downloaded. After deploying the patch, run a built backend explicitly:

```sh
pnpm build
pnpm operational-media:reconcile
```

The command operates in bounded batches (`CERP_OPERATIONAL_MEDIA_RECONCILE_BATCH_SIZE`, 1–500; default 100). It verifies containment/inode identity, byte signature (PNG/JPEG/WebP/GIF/PDF), size and SHA-256, then scans the exact bytes read from the verified inode. Only a clean verdict activates an asset. Missing, unsafe or malformed bytes and infected files are marked `QUARANTINED`; scanner-unavailable rows remain `LEGACY_UNVERIFIED` for a later retry. Its output and logs contain only opaque asset IDs and aggregate counts.

Before/after deployment run the paired `preflight.sql` and `verify.sql` support
scripts. The verify script independently derives expected binding rows from
every available producer table, so shared legacy files cannot conceal a missing
owner binding. Roll back the application DTO/content contract together with the
paired rollback SQL; legacy path columns and physical files are intentionally
preserved.

Supplier logos are read-only legacy media in this release. The supplier JSON
contract may clear a logo with `null`, but it cannot accept a storage key and no
supplier-logo upload producer exists. A future upload flow must stage, scan,
promote and bind the file server-side; it must not restore raw-path input.
