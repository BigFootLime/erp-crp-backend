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

## Issue #168 - Réparation des catégories Article orphelines

Patch `20260727_repair_article_category_orphans_168.sql` répare deux liens
résiduels laissés par un Article de recette supprimé. La reconstruction de
l’Article est interdite car sa Pièce technique et son Affaire n’existent plus.

La réparation est bornée par l’identité et les SHA-256 des preuves, rescane
toutes les références Article, copie les lignes originales dans
`erp_audit_logs`, retire uniquement les deux liens puis valide la clé étrangère.
Le preflight est en lecture seule. Le rollback est limité à `cerp_test` et
restaure exclusivement les lignes conservées dans l’audit.

Voir `docs/data-integrity-repair-168.md`.

Validation du 2026-07-27 : cycle complet avec rollback sur `cerp_test`,
sauvegarde production vérifiée, correction appliquée et enregistrée sur
`cerp_prod`, puis comparaison canonique des 300 tables non concernées sans
aucune différence.

## Issue #55 - Recursive Fabrication Tree

Patch `20260624_recursive_fabrication_tree_of_hierarchy.sql` adds only new
structures for recursive OF generation:

- `of_generation_batches` tracks one recursive generation batch from a command
  line.
- `ordres_fabrication` gains parent/root/generation metadata for OF trees.
- `of_structure_snapshot` freezes the fabrication tree context at generation
  time.
- `of_operations.source_piece_operation_id` links copied OF operations back to
  the source routing operation.

This patch does not rename or remove historical tables. The technical table
`pieces_techniques_nomenclature` remains the manufactured parent/child
structure, while `pieces_techniques_achats` remains the purchase/procurement
structure.

## Issue #141 - Codification, versions techniques et VSM

Patch `20260713_codification_versions_of_vsm.sql` is additive and must be
applied to `cerp_test` before any production decision. It adds:

- the external-index/internal-revision separation and immutability triggers on
  `piece_technique_versions`;
- an applicable-version reference and SHA-256 technical snapshot for each OF;
- controlled VSM/document evidence metadata for Project Office.

Run `db/patches/support/20260713_codification_versions_of_vsm.verify.sql`
after application.

Before `cerp_test` and again before `cerp_prod`, run the read-only
`db/patches/support/20260713_codification_versions_of_vsm.preflight.sql`.
It reports missing/ambiguous client-plan-index mappings, old index collisions,
OFs already in use, migration state and sequence counters. It never updates
data and no automatic mapping is permitted for an ambiguous row.

Project Office evidence requires `CERP_DOCUMENTS_ROOT` in production. It must
be an explicit persistent, shared mount available to every application
instance; the API refuses evidence storage when production lacks that setting.
The companion rollback script is deliberately guarded and refuses to remove
post-migration technical versions/metadata, code allocations, quality-control
references, retained OF snapshots, or Project Office evidence. The additive
The VSM file category is enforced by the dedicated
`project_evidence_files_category_check` table constraint. The patch deliberately
does not alter the historical `po_evidence_type` enum, which can be owned by the
administrative PostgreSQL role while runtime patches are executed by `cerp_app`.

## Issue #165 - Parc machines

Patch `20260722_machine_park_165.sql` is additive and idempotent. It reserves the central `MCH` scope, makes unknown hourly rates nullable with explicit provenance, adds a legacy alias, enforces code immutability, records creation idempotency, links machine unavailability to canonical `planning_events`, and adds maintenance plans/events plus document metadata/removal fields.

Before any application, run `db/patches/support/20260722_machine_park_165.preflight.sql`. Apply only to `cerp_test` after an approved backup, then run `20260722_machine_park_165.verify.sql`. The guarded rollback refuses to drop structures once machine-park business rows exist and intentionally preserves rate provenance/code immutability where reverting would lose traceability. No #165 script is authorized to write `cerp_prod` without a later human production decision.

## Issue #223 - Réceptions de production

Patch `20260723_production_receipts_223.sql` adds an immutable, actor-scoped
idempotency ledger (`of_receipts`), explicit lot links on stock batches and
reservations, and the read model `v_stock_lot_availability`. Physical on-hand,
quarantine, blocked, reserved and available quantities remain distinct.

Run the matching `preflight` and `verify` scripts from `db/patches/support`.
The rollback is restricted to `cerp_test` and refuses to continue once a
receipt or lot-level reservation exists. Validation on 2026-07-23 used the
isolated `cerp_test` clone first. After explicit human approval, production was
backed up to `cerp_prod_pre_223_20260723_145750.backup` (SHA-256
`9a037c37563e1bbc57fa34b7e8c3fd2aaa1cca09e0b994628e5f0d4e9ab83dc1`),
then the patch was applied, verified and recorded in
`public.cerp_schema_migrations`.

## Issue #225 - Stock, lots, mouvements, magasins et inventaires

Patch `20260723_stock_traceability_225.sql` extends the existing stock ledger
with actor-scoped immutable command receipts, correlated reversals/transfers,
quality-aware availability, source-backed reservations, lot genealogy and
versioned inventory snapshots/count events. Posted and cancelled industrial
evidence cannot be rewritten.

Run `20260723_stock_traceability_225.preflight.sql` before applying the patch
and `20260723_stock_traceability_225.verify.sql` afterwards. The #225 support
scripts are restricted to `cerp_test`; the guarded rollback refuses to drop
structures once #225 evidence exists. Patch application itself remains under
the migration runner, backup policy and explicit human environment gate. The
preflight also checks the cross-module users, units, warehouses, locations,
orders, OF, BL, affairs, lot and batch prerequisites inherited from the active
schema.

No `DATABASE_URL` for `cerp_test` was configured in the #225 workspace on
2026-07-23, so the patch was not applied or registered on any database.
`cerp_prod` was not modified.

## Issue #274 - Suivi et pointage de production 360

Patch `20260726_production_execution_274.sql` consolidates
`production_pointages` and `of_time_logs` without deleting or rewriting either
history. `production_pointages` is canonical; correlated legacy rows carry
`pointage_id` and are excluded from the residual term of
`fn_production_operation_real_hours`, so a minute is counted exactly once.

The compatibility adapter is a PostgreSQL trigger on `of_time_logs`. It mirrors
legacy START/STOP into the canonical pointage inside the same transaction,
preserving the historical HTTP contract and preventing partial state.

Support files:

- `preflight.sql`: read-only prerequisites, volumes and overlap detection;
- `verify.sql`: structure, categories, constraints and independent
  anti-double-counting proof;
- `smoke.sql`: runs as `cerp_app`, exercises START/double START/STOP and rolls
  back all fixtures;
- `recompute-history.sql`: updates only derived `temps_total_real`, guarded by
  an explicit `expected_database`;
- `rollback.sql`: test-only and refuses to remove structures carrying evidence.

On 2026-07-26, `cerp_test` was backed up, migrated, verified, replayed and
smoke-tested successfully. Preflight found no overlaps and no historical gap;
the recompute changed zero operations. The production application remains a
separate backup/preflight/verify gate.

## Issue #228 - Qualite industrielle 360 : plans, controles, liberation, NC, derogations et CAPA

Patch `20260725_qualite_360_228.sql` adds the governance layer the Qualite
module was missing: versioned control plans with an immutable published state,
a canonical plan snapshot with its SHA-256 fingerprint frozen on each control
execution, a quantity ledger enforced by CHECK constraints (controlled <=
population, conforming <= controlled, released <= conforming, consumed <=
released, dispositions <= population), append-only release decisions, a
derogation/concession registry with immutable consumptions, a bounded 5 Why /
8D structure, and actor-scoped idempotency receipts.

The patch is **additive, idempotent, transactional and inactive**: it creates
no plan, no derogation, no release decision and no disposition, it never
touches `public.lots` statuses and it never writes a stock movement. Historical
enums are **extended, never duplicated** — `quality_nc_status` gains `DRAFT`,
`DISPOSITION`, `VERIFICATION` and `CANCELLED`; `quality_entity_type` gains
`PLAN`, `DEROGATION` and `RELEASE`; the disposition CHECK list gains `RECHECK`.
The new enum values are deliberately not consumed inside the same transaction,
per the documented PostgreSQL 12+ restriction on `ALTER TYPE ... ADD VALUE`.

Codification: `public.fn_next_issued_code_value` gains the `PC` (control plans)
and `DER` (derogations) scopes, exactly as `#172` added `BCF`. The function body
is otherwise identical; only the whitelist regex changes.

Guard triggers installed by the patch:

- `trg_protect_quality_plan_228` / `trg_protect_quality_plan_char_228` — a
  published or archived plan and its characteristics are immutable.
- `trg_protect_quality_snapshot_228` — the applied plan snapshot, its hash, the
  population, the unit and the source of a validated control cannot be rewritten.
- `trg_protect_quality_measurement_228` — a measurement of a validated control
  requires an audited revision and can never be deleted.
- `trg_quality_*_append_only_228` — event log, measurement revisions, release
  decisions, derogation consumptions and command receipts are append-only.
- `trg_protect_quality_derogation_228` / `trg_check_quality_derogation_cap_228`
  — an approved derogation keeps its scope, deviation and caps, consumption
  never decreases, and consumptions cannot exceed the approved maximum.
- `trg_protect_quality_documents_228` — quality documents are removed logically
  only, a decision-evidence document cannot be removed, and the file identity
  (hash, storage path) is immutable.

Run `db/patches/support/20260725_qualite_360_228.preflight.sql` before applying
and `...verify.sql` afterwards. All three support scripts are restricted to
`cerp_test`. The rollback refuses to continue once a release decision, a
derogation consumption, a measurement revision, a plan snapshot, an extended NC
status or any new column value exists; enum values added by #228 cannot be
removed by PostgreSQL and stay in place.

Le patch #228 a été appliqué et vérifié le 2026-07-25 sur `cerp_test`, puis sur
`cerp_prod` après sauvegarde. L'application par le rôle administratif a révélé
un écart d'ownership sur huit tables : le schéma était présent, mais les
connexions runtime `cerp_app` recevaient des erreurs de permission. Le correctif
#132 ci-dessous ferme cet écart sans modifier de donnée métier.

### Issue #132 - Runtime access for Qualite 360

Patch `20260725_qualite_360_228_runtime_access.sql` corrects the ownership of
the eight tables introduced by #228. When the #228 patch is executed by the
administrative PostgreSQL role, those tables otherwise remain owned by
`postgres` and API connections using `cerp_app` receive permission errors.

The corrective patch is transactional and idempotent. It changes no business
row and hands only the #228 tables to the existing runtime owner `cerp_app`.
Run the matching preflight and verification scripts on `cerp_test` first. The
rollback is also restricted to `cerp_test` and only restores the previous
`postgres` owner; it never drops schema or business data.

Validation du 2026-07-25 :

- tests de garde du patch : 23/23 ;
- préflight, application et vérification sur `cerp_test` ;
- sauvegarde `cerp_prod` exécutée avant changement ;
- application transactionnelle sur `cerp_prod` ;
- les huit tables sont possédées par `cerp_app` et
  `has_table_privilege(..., 'SELECT,INSERT,UPDATE')` retourne vrai ;
- le Centre Qualité de production recharge sans erreur API v2.

## Release industrielle 360 du 2026-07-26

Avant toute écriture, `cerp_prod` a été sauvegardée dans
`/var/backups/cerp/cerp_prod_release_20260726-1615.dump`. Le fichier mesure
37 706 913 octets et son catalogue `pg_restore --list` contient 3 146 entrées.

Les préflights ont été exécutés en lecture seule, puis les patches ont été
appliqués transactionnellement et vérifiés dans cet ordre :

1. `20260726_production_execution_274.sql` : schéma déjà présent et conforme ;
   enregistrement de l'état vérifié dans `cerp_schema_migrations` ;
2. `20260726_tracabilite_360_142.sql` : table de consommation matière,
   contraintes, trigger append-only, index, durcissement as-built et ownership
   `cerp_app`, sans backfill déduit ;
3. `20260726_fix_facturation_child_trigger_227.sql` : création d'une ligne de
   facture prouvée, immutabilité après émission prouvée avec SQLSTATE `55000`,
   transaction de test annulée et zéro résidu ;
4. `20260726_reporting_commercial_360_275.sql` : 17 index présents, valides et
   prêts, lisibilité applicative confirmée ;
5. `20260726_pieces_techniques_landing_146.sql` : 6 index présents, valides et
   prêts.

Les cinq lignes du registre portent les empreintes SHA-256 exactes des fichiers
versionnés. Aucun jeu de données de recette n'a été conservé dans `cerp_prod`.

## Issue #169 - Validation des références vers les articles fabriqués

Patch `20260727_validate_article_fabrique_references_169.sql` valide les trois
clés étrangères historiques de `commande_ligne`,
`commande_cadre_release_ligne` et `ordres_fabrication` vers
`articles_fabrique`. Elles avaient été créées avec `NOT VALID` par
`20260319_articles_domain_subtypes.sql`.

Le préflight prouve d'abord que chaque référence non nulle possède sa cible.
Le patch est transactionnel, idempotent, limité à `cerp_test` et `cerp_prod`,
et ne modifie aucune ligne métier. La procédure et le rollback test-only sont
documentés dans `docs/article-fabrique-fk-validation-169.md`.

Validation du 2026-07-27 : cycle complet avec rollback sur `cerp_test`,
sauvegarde production vérifiée, trois contraintes validées sur `cerp_prod`,
zéro référence invalide, toutes les clés étrangères publiques validées et
empreintes des 302 tables métier inchangées.
