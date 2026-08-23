# #611 operational-media migration cycle

- Date: 2026-08-23
- Target: disposable PostgreSQL 16 container on loopback.
- Scope: realistic minimal fixtures for every producer: client/user/machine,
  outil image/plan/esquisse, family, geometry and manufacturer. No production
  database, operational filesystem, credentials, or real media files were
  used.

## Cycle evidence

1. **Preflight** reported absent registry/bindings, available `pgcrypto`
   functions, valid client/machine producer keys, and a read-only
   per-producer compatibility inventory. It reports only owner type, field and
   aggregate local/ignored/rejected/unsupported/ambiguous counts; unsupported
   or extensionless local values fail before the migration can bind them.
2. Applied the patch to 16 source rows. The source-derived matrix contained
   **13 bindings** over **11 assets**, including the same valid GIF key shared
   by two clients and one user. A valid GIF activated cleanly; a plan PDF also
   activated cleanly.
3. The normalizer accepted canonical, relative-marker, absolute-marker,
   backslash and mixed-case marker variants. It rejected remote URLs, unmarked
   drive/UNC paths, controls, colon-bearing local keys, and traversal before or
   after the marker. A Windows path containing the established marker remained
   supported. Marker-like
   `notuploads/images/...` text remained a literal canonical relative key; it
   was never reclassified as a legacy marker.
4. The closed MIME/binding policy rejected both ordering attacks: activating
   `primary-image.pdf` while bound to `outil.image`, and adding a client logo
   binding after an otherwise clean active PDF. A simulated early #611 state
   with that bad active primary-PDF was replayed; the upgrade quarantined it.
   `verify.sql` then reported both `no_pdf_primary_tool_images` and
   `no_active_media_with_incompatible_binding_mime` as true.
5. Ran `rollback.sql`: both registry tables and all 11 #611 triggers were
   absent, while all **16** source rows remained. The migration has no
   filesystem statements, so no media file was modified.
6. Reapplied, verified, and replayed the patch. The source matrix again had
   zero missing/mismatched bindings; replay retained the named active-integrity
   constraint, **2** policy triggers, **11** total #611 triggers, **11** assets
   and **13** bindings.
7. The compatibility gate was exercised separately with valid, remote, and
   traversal values: it completed with aggregate counts only. SVG and
   extensionless local fixtures each failed before migration with
   `OPERATIONAL_MEDIA_PREFLIGHT_UNSUPPORTED_EXTENSION`. A mutable client owner
   update removed the old binding and created the new one; replay repaired a
   deliberately mismatched existing binding back to the source-derived asset.
8. A supplier fixture (`fournisseurs.id`, `logo`) was included in a separate
   preflight/apply/verify/rollback/reapply/replay cycle. It produced the
   `fournisseur/logo/fournisseurs` binding, preserved the supplier row after
   rollback, and retained exactly one supplier binding after replay.

Supplier logo JSON accepts only `null` (clear). There is deliberately no
supplier-logo upload producer yet: a caller cannot submit a storage key and
bind another module's private media. Legacy logo values are migration-only.

The rehearsal previously exposed an autocommit verifier defect (`ON COMMIT
DROP`), a traversal-admitting PostgreSQL regular expression, and an
activation-only PDF policy. The final patch uses `ON COMMIT PRESERVE ROWS`,
explicit PostgreSQL segment comparison, and two-sided MIME/binding triggers.
The named active-integrity constraint remains replay-safe, so anonymous early
#611 checks cannot retain a raster-only contract. Per-field outillage trigger
names were also replayed successfully.

## Runtime command

After building, the reconciliation command resolves to
`dist/module/operational-media/scripts/reconcile-legacy.js` and is invoked as:

```sh
pnpm build
pnpm operational-media:reconcile
```

It was not executed against a live database as part of this evidence run. The
reconciliation service scans the exact bytes read and hashed from the verified
inode (not a pathname), including the supported PDF content.
