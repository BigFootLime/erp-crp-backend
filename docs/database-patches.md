# Database Patches

CERP stores SQL patch files in `db/patches/`. The local-first production
database is PostgreSQL on HYPERBOX2, database `cerp_prod`.

Do not make schema changes directly on the VPS. The VPS must not become a
second writable database.

## Gate de release SOL-06

Toute mise à niveau suit désormais `docs/runbooks/database-upgrade-sol06.md`.
Les commandes `db:migrations:inventory`, `db:migrations:preflight`,
`db:migrations:integrity` et `db:migrations:rehearse` couvrent respectivement
l'inventaire statique, la sauvegarde/prérequis en lecture seule, les comptages
et orphelins post-migration, puis la preuve complète dans PostgreSQL jetable.
Le patch `20260810_system_reference_data_readiness.sql` bloque côté base les
flux stock, planning et production dont les référentiels sont incomplets.

## SOL-20 — Outillage, dossier technique et GED

`20260813_sol20_tooling_technical_ged.sql` ajoute le cycle réservation/sortie/
retour/casse/usure, les paramètres datés, les exigences d'outils par indice et la
validation des liens GED canoniques. Utiliser le preflight, le verify et le rollback
du même nom dans `db/patches/support/`, puis suivre
`docs/runbooks/tooling-technical-ged-sol20-migration.md`. Le rollback refuse toute
suppression après création d'une preuve métier ; la restauration du dump devient
alors la seule stratégie de retrait de schéma.

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

The runner owns `public.cerp_schema_migrations`; patch files must not insert a
second, competing registry row. For `up`, it normalizes SQL line endings to LF
for a platform-independent SHA-256, removes a supported outer `BEGIN`/`COMMIT`
wrapper for execution, pins `standard_conforming_strings=on` transaction-locally
so its lexer matches PostgreSQL, and commits the patch plus `filename`, `sha256`
and `applied_at` together. A registry-write failure therefore rolls the patch back.
`baseline` remains a separate metadata-only operation: it never executes patch
SQL and is allowed only after the represented schema has been verified manually.

For targeted rollouts, registered `--only` patch basenames are immutable
selectors. The runner accepts the exact basename only, verifies its
canonical LF SHA-256, still evaluates the complete patch inventory for checksum
mismatches, and applies zero or one selected patch according to its
`pending`/`applied` status. The selector always reads the repository's canonical
`db/patches` directory; it refuses `--patch-dir`, substituted directories and
symbolic-link SQL files so a reduced inventory cannot conceal another applied
checksum mismatch. `--only` is deliberately unavailable to `baseline`.

The rate-limit table is owned by `cerp_app`. Its explicit table ACL is exactly
`SELECT`/`INSERT`/`UPDATE`/`DELETE` for that role, with no grant option, no
`PUBLIC` entry, no other grantee and no column ACL. The patch removes creator
default-ACL leakage before recording the migration. Effective ordinary table
rights are the same four DML privileges: `TRUNCATE`, `REFERENCES` and `TRIGGER`
are revoked. PostgreSQL ownership still carries inherent alter/drop/regrant
authority; verification and rollback account for that separately and reject
every owner other than `cerp_app`.

## Rules

- Before any database change, download or retrieve the latest SQL backup from
  the VPS/Coolify backup system first.
- Keep a local PostgreSQL backup as an additional safety net, but do not treat
  it as a replacement for the VPS/Coolify backup requested for CERP DB work.
- Prefer additive SQL changes.
- Do not edit a patch file after it has been applied; add a new patch instead.
- Review `checksum-mismatch` results before continuing.
- Apply primary patch files through `db:patches:up`, not directly with `psql`,
  so schema state and the migration registry cannot diverge.
- Keep passwords and `DATABASE_URL` out of Git, logs, and tickets.

## Issue #446 - Stock functional scopes OLD/NEW

Correctif applicatif du 2026-08-10 :

- l’alimentation PF de Base OLD utilise désormais le statut technique canonique
  `DRAFT`, accepté par la contrainte de `pieces_techniques`, au lieu de la valeur
  historique invalide `EN_DEVIS` qui provoquait le `500 INTERNAL_ERROR` ;
- une reprise OLD reste un mouvement d’ouverture autonome, sans clé étrangère
  vers une Affaire, une commande ou un OF ; les numéros éventuellement saisis
  sont seulement des repères texte sur le lot ;
- `20260810_stock_old_new_navigation_446.sql` ajoute de façon idempotente les
  clés `stock-base-old` et `stock-base-new` au catalogue persistant du module
  Stock, sans remplacer les clés déjà présentes. Son preflight et sa vérification
  sont en lecture seule ; son rollback est limité à `cerp_test`.

Ce nouveau patch de navigation peut être appliqué seul avec
`--only 20260810_stock_old_new_navigation_446.sql`. Son exécution sur
`cerp_test` puis `cerp_prod` reste soumise aux sauvegardes, contrôles et décisions
humaines décrits plus haut.

Application `cerp_test` réalisée le 2026-08-10 à 16:16 CEST : préflight et
vérification réussis, empreinte enregistrée
`4900f01411ab89349874fcd6d28993aa34a1ec560320d4d32b05489800bf3b9b`.
Sauvegarde de retour arrière conservée sous
`/var/backups/cerp/cerp_test_pre_446_nav_20260810-161340.dump` (SHA-256
`aabbb8c377db2f1b9fcaf5213fd9168fe54599b337329287da60d99a9c2a83e7`).
Application `cerp_prod` réalisée le 2026-08-10 à 17:03 CEST après confirmation
explicite de la cible : préflight et vérification réussis, même empreinte de
migration, six clés de navigation Stock distinctes. Sauvegarde production
conservée sous `/var/backups/cerp/cerp_prod_20260810-170142.dump` (SHA-256
`3ab2e6887e47a47e096c08862dddc255fd53ec65f73b54dc531a3abb92326a36`).

`20260731_stock_old_new_446.sql` is additive and was applied to both
`cerp_test` and `cerp_prod` on 2026-07-31. It adds the four fixed functional stores
`OLD-PF`, `OLD-MP`, `NEW-PF`, `NEW-MP`, lot opening provenance/traceability,
and the `Fourniture Client` label without changing the stable technical code
`achat_transforme`.

Required operating order: retrieve and verify a restorable backup, run the
read-only `db/patches/support/20260731_stock_old_new_446.preflight.sql`, apply
the patch to `cerp_test` using the normal runner, run the read-only
`...446.verify.sql`, then execute the business recipe (full stock: reservation
and BL without OF; shortage: delivery decision, then OF for the missing quantity).
The `...446.rollback.sql` script is test-only and refuses to delete the patch
as soon as OLD/NEW movements, lots, trace references, locations or Fourniture
Client values exist.

Deployment record (HYPERBOX2): the migration checksum recorded in both patch
ledgers is
`624bb347dfd0458b913cad1fe25affc71ef0bdf3a2a1e2c9250f6f10589af794`.
The verified pre-migration backups are
`/var/backups/cerp/cerp_test_pre_446_20260731-234440.dump` (74,339,659 bytes)
and `/var/backups/cerp/cerp_prod_20260731-234848.dump` (50,866,662 bytes).
Preflight, apply and read-only verification passed on both databases;
`cerp_test` was then reapplied successfully to confirm idempotence.

### Comportement applicatif après patch

Cette section ne décrit pas une nouvelle migration. Après le contrôle `OLD` puis
`NEW`, une commande entièrement couverte réserve le stock et prépare le BL sans
OF ni Planning. En cas de manque, le stock disponible est réservé et seuls les
manquants génèrent des OF ; la quantité proposée peut être majorée pour une
reconstitution volontaire de stock. Lors de la préparation du BL, une réservation
active provenant du lancement est transférée à la ligne de BL au lieu d'être
dupliquée. L'expédition crée la sortie de stock et synchronise la commande vers
`LIVRE`; l'état `FACTURE` ne peut suivre que l'émission Finance explicite.

Les paramètres légaux et la politique d'émission Finance restent à valider par
Finance/Juridique. Les recettes frontend et le déploiement applicatif restent à
compléter séparément.

## Issue #164 - Règles Articles / matière / Stock restantes

`20260729_articles_164_remaining_rules.sql` ajoute les sept profils matière
canoniques, le propriétaire du brut client, les longueurs industrielles
distinctes, la quantité linéaire par Article/lot et la base de prix fournisseur
`NONE`/`KG`/`M`.

La densité publique devient le kg/m³ dans une nouvelle colonne
`stock_nuances.densite_kg_m3`. La colonne historique `densite` reste en kg/dm³
et est synchronisée pour assurer la compatibilité ; la reprise applique
exactement `kg/m³ = kg/dm³ × 1 000`. L'audit du 2026-07-29 n'a trouvé aucune
densité renseignée dans `cerp_test` ou `cerp_prod`.

Ordre obligatoire : préflight, sauvegarde, patch sur `cerp_test`, verify,
rollback test-only, réapplication et recette. Le rollback refuse toute base
autre que `cerp_test` et toute nouvelle donnée utilisant les champs. Aucune
application automatique à `cerp_prod` n'est autorisée.

Validation du 2026-07-29 : sauvegarde `cerp_test` vérifiée, préflight vert,
application/verify/rollback/réapplication/verify réussis, patch enregistré sous
le SHA-256 `ecf89b47af9d62fe96642c232aad75a64f6414071fad7d3e5b4416d8658e1236`.
Les volumes sont restés 272 Articles matière, 0 lot, 233 lignes de mouvement et
0 prix fournisseur. `cerp_prod` n'a pas reçu ce patch.

## Issue #167 - Assistant d’import CLIPPER

Patch `20260726_import_assistant_167.sql` ajoute le staging reprenable, le
crosswalk CLIPPER vers CERP, l’idempotence de confirmation et l’idempotence de
création fournisseur/pièce. Il n’importe aucune donnée métier.

Les routes de l’assistant sont en plus verrouillées sur l’identité réelle du
pool PostgreSQL : `SELECT current_database()` doit retourner exactement
`cerp_test`, sinon l’API répond `409 IMPORT_TEST_DATABASE_REQUIRED`. Le routage
HTTP ne constitue donc pas à lui seul une autorisation d’import.

Ordre obligatoire sur `cerp_test` :

1. exécuter `support/20260726_import_assistant_167.preflight.sql` ;
2. appliquer le patch par le mécanisme normal ;
3. exécuter `support/20260726_import_assistant_167.verify.sql` ;
4. réaliser la recette pilote documentée dans `docs/import-assistant.md`.

Les contenus source et normalisés de staging sont purgés après 90 jours par
`fn_purge_expired_import_staging()`. Le crosswalk et la preuve minimale restent
conservés. Le rollback automatique est volontairement bloqué dès qu’une preuve
ou correspondance pourrait être perdue.

Validation du 2026-07-27 :

- défauts de données #168 et de validation de contraintes #169 corrigés et
  vérifiés avant la reprise ;
- `cerp_test` recréée depuis le dump vérifié
  `/var/backups/cerp/cerp_prod_20260727-020006.dump` ;
- ancienne base préservée sous
  `cerp_test_pre_import_167_168_169_20260727_0200`, connexions désactivées ;
- volumes et empreintes des 303 tables identiques avant patch ;
- patch #167 appliqué avec les objets possédés par `cerp_app` ;
- preflight, verify, accès runtime et smoke transactionnel réussis ;
- zéro résidu du smoke test, zéro lien de catégorie orphelin et toutes les clés
  étrangères publiques validées ;
- assistant d’import présent uniquement dans `cerp_test`, aucune table de
  staging #167 créée dans `cerp_prod`.

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

## Issue #315 - RBAC multi-rôles

Le patch `20260727_user_multi_roles_315.sql` crée un catalogue de rôles
applicatifs et les affectations plusieurs-à-plusieurs entre utilisateurs et
rôles. Il conserve `users.role` comme rôle principal de compatibilité et
reprend chaque compte existant dans `user_role_assignments`. Les attributions,
révocations et reprises sont conservées dans le journal append-only
`user_role_assignment_events`, avec l'acteur lorsqu'il est connu.

Le patch préalable `20260727_user_account_profile_optional_315.sql` permet de
créer le compte ERP avant de connaître les données RH sensibles. Téléphone,
adresse, date de naissance et NIR restent `NULL` plutôt que d'être remplacés
par des valeurs fictives. Les contraintes `UNIQUE` restent en place et
s'appliquent dès qu'une valeur réelle est renseignée.

Le patch est transactionnel et idempotent. Il accorde explicitement au rôle
applicatif de moindre privilège `cerp_app` la lecture du catalogue, la gestion
des affectations et uniquement la lecture/ajout du journal append-only. Son
script de vérification contrôle la présence des trois tables, le catalogue
actif, l'absence de compte sans affectation de son rôle principal et ces
privilèges applicatifs, y compris l'absence de droit `UPDATE`/`DELETE` sur le
journal. Le rollback de support supprime uniquement les trois nouvelles
tables ; il ne modifie aucune ligne de `users`.

Ordre obligatoire : exécuter
`support/20260727_user_multi_roles_315.preflight.sql`, appliquer les deux
patches sur `cerp_test`, exécuter leurs vérifications, puis réaliser la recette
des sessions mono-rôle et multi-rôles. Une validation humaine explicite reste
obligatoire avant toute application sur `cerp_prod`.

Validation d'exploitation du 2026-07-27 : sauvegarde `cerp_test` vérifiée,
application des deux patches et recette des sessions multi-rôles sur l'API
isolée ; sauvegarde `cerp_prod` vérifiée par catalogue et SHA-256 avant
application identique. Les deux bases exposent 33 rôles actifs, aucun compte
sans rôle principal et des privilèges applicatifs conformes. La recette a
couvert 17 comptes provisionnés, 64 affectations et six profils d'accès
représentatifs, sans modifier le compte administrateur existant.

## Issue #326 - Tour de contrôle des accès

Le patch `20260727_admin_access_tower_326.sql` installe le socle du filtrage
module par compte : la colonne marqueur `users.is_superadmin`, le catalogue
`app_modules`, les décisions explicites `app_module_user_access` et le journal
append-only `app_module_access_events`, protégé par le même mécanisme de trigger
que `user_role_assignment_events` (#315).

Le patch est transactionnel, idempotent et strictement additif. Il ne pose
aucune restriction : les vingt modules du catalogue naissent avec
`enabled_by_default = true`, et une restriction ne peut résulter que d'une
décision explicite tracée. La réapplication met à jour le libellé, la
description, la catégorie, les préfixes d'API, les clés de navigation et l'ordre
d'affichage, mais **jamais** `enabled_by_default` ni `is_active` : une décision
d'exploitation déjà prise ne doit pas être effacée par une migration. Seule
exception assumée, le drapeau `is_protected` du module `administration` est
réaffirmé, et les éventuelles restrictions posées sur un module protégé sont
supprimées — c'est ce qui garantit qu'aucune décision ne peut rendre l'ERP
inadministrable.

Le journal ne porte volontairement aucune clé étrangère : le trigger append-only
interdit tout `UPDATE`, donc un `ON DELETE SET NULL` sur `user_id` ferait échouer
la suppression d'un compte. Le journal doit survivre à la disparition de l'acteur
comme de la cible.

Le patch accorde à `cerp_app` le strict nécessaire : lecture du catalogue et
`UPDATE` limité aux seules colonnes `enabled_by_default` et `updated_at`, gestion
complète des décisions utilisateur, lecture et ajout seulement sur le journal.
Le script de vérification contrôle ces privilèges, y compris l'absence de droit
`INSERT`/`DELETE` sur le catalogue, l'absence de droit `UPDATE` sur `module_key`
et l'absence de droit `UPDATE`/`DELETE` sur le journal. Il vérifie aussi que les
vingt clés de module attendues sont présentes : une clé manquante ferait
silencieusement tomber le gate serveur en mode ouvert sur le module concerné.

Le statut superadmin n'est accordé par **aucune API**. `is_superadmin` est exposé
en lecture seule par `/admin/users` et `/admin/users/:id` ; le fournir dans le
corps d'un `PATCH` est un rejet de validation, pas une ignorance silencieuse. Le
seul chemin d'octroi est le seed gardé
`db/seeds/access-tower-superadmin-keenan.sql`, qui refuse de s'exécuter sur
`cerp_prod` sans `SET cerp.access_tower_superadmin_approved = 'KEENAN'`, refuse
si la colonne n'existe pas encore, et refuse si le nom d'utilisateur ne
correspond pas exactement à un compte unique.

Ordre obligatoire : exécuter
`support/20260727_admin_access_tower_326.preflight.sql`, appliquer le patch sur
`cerp_test`, exécuter la vérification, appliquer le seed superadmin sur
`cerp_test`, puis réaliser la recette navigateur de la tour de contrôle. Une
validation humaine explicite reste obligatoire avant toute application sur
`cerp_prod`. Le rollback de support supprime les trois tables, le trigger, sa
fonction et la colonne ajoutée ; il ne modifie aucune ligne de `users`.

Le socle serveur tolère l'absence de ce patch : une erreur PostgreSQL `42P01`
fait passer le gate en mode ouvert avec un avertissement journalisé, et
`/api/v1/auth/access-profile` répond `{ "is_superadmin": false, "modules": [] }`
en 200. Briquer l'ERP entier serait pire que ne pas filtrer. Dès que
l'infrastructure existe, la décision redevient fermée par défaut.

État au 2026-07-27 : patch, scripts de support et seed **écrits et versionnés,
appliqués sur aucune base**. Ni `cerp_test` ni `cerp_prod` n'ont été modifiés.

## Issue #402 - Granularité des modules récents dans la Tour d'accès

Le patch `20260730_repair_module_catalog_visibility_402.sql` fait apparaître
séparément dans la matrice d'habilitation : **Pièces techniques**,
**Bibliothèque de finitions**, **Méthodes — Centres de frais**, **Méthodes — Parc
machine** et **Gestion documentaire**. Les nouveaux espaces sont ainsi réglables
compte par compte, sans donner accès à toute la rubrique Données techniques.

Le patch est transactionnel et idempotent. Les nouveaux modules héritent une seule
fois de l'état actif et du défaut historique de `pieces-techniques`; il ne réécrit
jamais ensuite leurs paramètres d'exploitation. Les overrides existants sur les
nouvelles clés sont conservés, et un override historique de `pieces-techniques`
est recopié vers les trois sous-espaces seulement lorsqu'aucun réglage dédié ne le
remplace. Aucun droit métier, donnée industrielle ou compte utilisateur n'est créé.

Ordre de recette : préflight #402, sauvegarde et application sur `cerp_test`,
verify #402, contrôle navigateur de la Tour d'accès avec un compte non superadmin,
puis seulement le même enchaînement sur `cerp_prod` après validation humaine. Les
scripts de préflight et de vérification refusent toute autre base. Le backend qui
porte le nouveau catalogue doit être redémarré dans la même fenêtre que le patch :
le résolveur de routes est volontairement côté code et ne doit pas cohabiter avec
la version de catalogue précédente.

## Mentions légales obligatoires de l'entité émettrice

Le patch `20260729_finance_legal_mentions.sql` fait suite au rendu unique des pièces
financières (#216). Il crée la table versionnée `finance_legal_mentions` et la fonction de
résolution `fn_finance_issuer_snapshot(biller_id, date)`, puis amorce l'entité émettrice.
Le correctif additif `20260729_finance_legal_mentions_hardening_221.sql` interdit les
chevauchements de périodes, sérialise les écritures concurrentes par émetteur et rend la
résolution explicitement déterministe. Le patch initial avait déjà été appliqué sur
`cerp_test` avant la revue #221 ; conformément à la règle d'immutabilité des patches
exécutés, il n'a pas été modifié.

Constat relevé le 2026-07-29 sur `cerp_test` **et** `cerp_prod` :

- `public.factureur` ne porte **aucune** colonne légale — ni `siret`, ni `siren`, ni `rcs`,
  ni `vat_number`, ni `capital_social`. Le serveur filtrait pourtant `to_jsonb(factureur)`
  sur exactement cette liste (`ISSUER_LEGAL_FIELDS`) : le filtre ne retenait jamais rien et
  aucune mention obligatoire n'était imprimée ;
- `public.factureur` est **vide** sur les deux bases, comme `finance_billing_policies` et
  `facture`. Aucune facture n'a jamais été émise par ce chemin, donc **aucun exemplaire
  immuable à préserver**.

Le versionnement n'est pas décoratif : une facture émise porte les mentions **en vigueur à
sa date d'émission** et ne se régénère jamais. Des colonnes posées sur `factureur` seraient
réécrites en place et falsifieraient rétroactivement l'historique ; une nouvelle version
laisse les instantanés déjà figés résoudre la leur. Un index unique partiel garantit au plus
une version ouverte par émetteur, sans quoi la résolution à une date donnée ne serait pas
déterministe.

Valeurs amorcées pour CROIX ROUSSE PRECISION, et leur source :

- registre national des entreprises (INPI) via `annuaire-entreprises.data.gouv.fr`, SIREN
  380569012, consulté le 2026-07-29 : forme juridique SARL (catégorie INSEE 5499), capital
  21 000,00 € fixe, TVA `FR73 380 569 012`, siège 530 rue de la Dombes, Les Échets,
  01700 Miribel, immatriculation du 28/01/1991 ;
- facture papier CERP n° 5256 du 24/07/2026 : pénalités 12,50 % annuel, escompte 1,50 %
  mensuel, réserve de propriété, TVA acquittée sur les encaissements, coordonnées bancaires.

Deux numéros de TVA figurent sur cette facture papier. Les deux clés de contrôle sont
valides mais portent sur des SIREN différents : seul `FR73 380 569 012` est cohérent avec le
SIRET `380 569 012 00020`. `FR40 800 163 065` est celui du client, pas de l'émetteur.

Deux mentions ont été **ajoutées** parce qu'elles manquaient à la facture papier et sont
obligatoires : l'indemnité forfaitaire de recouvrement de 40 € (art. D441-5, décret
2012-1115) et la ville du RCS — Miribel relève de l'Ain, dont le ressort unique est le
greffe de Bourg-en-Bresse. « RCS : 380569012 » sans ville est incomplet au regard de
l'art. R123-237.

`effective_from` est fixé au 1er janvier 2026 : c'est la période la plus large que l'on
puisse couvrir sans affirmer ce qui était en vigueur les années précédentes. Aucune facture
n'existant en base, aucune pièce ne se retrouve hors période.

Ordre obligatoire : exécuter `support/20260729_finance_legal_mentions.preflight.sql`,
appliquer les deux patches dans l'ordre sur `cerp_test`, exécuter la vérification. Le
rollback est restreint à `cerp_test` et refuse de s'exécuter dès qu'une pièce porte un
instantané d'émetteur. Une validation humaine explicite reste obligatoire avant toute
application sur `cerp_prod`.

Validation du 2026-07-29 : sauvegarde `cerp_prod_20260729-110843.dump` (50 642 473 o)
vérifiée avant toute écriture ; préflight en lecture seule confirmant 0 factureur,
0 politique et 0 facture ; patch appliqué et enregistré dans `cerp_schema_migrations`
(SHA-256 `814dcc7dbb51dd13eb3ce2a3656ce729716b8d7e7f66ac473d31e79e0e461a4d`) ; vérification
complète réussie — 11 contraintes, une seule version en vigueur, instantané portant les
treize clés obligatoires, résolution hors période rendant l'identité **sans** mentions, et
`finance_legal_mentions` possédée par `cerp_app`. **`cerp_prod` n'a pas été modifiée.**

# 20260809 — Account invitation and administrative reset idempotency (SOL-02)

`20260809_account_invitation_activation.sql` adds one-use administrative invitations and idempotency metadata for administrative password-reset creation. Run the matching support preflight, take a restorable backup, apply, then run verify. The rollback is intentionally refused once account-lifecycle evidence exists; disable application routes and preserve evidence instead.

## 20260814 — Intelligence qualité, coûts, causes et SPC (SOL-22)

`20260814_sol22_quality_intelligence.sql` ajoute le catalogue de causes, le ledger
append-only des coûts qualité et les politiques SPC versionnées. Il renforce aussi
la vérification des CAPA exigeant une preuve. Exécuter le preflight, produire et
restaurer un dump vérifié, appliquer avec le runner de patches puis exécuter le
verify. Le rollback support est limité à `cerp_test` et refuse toute suppression
dès qu'une cause, un coût ou une politique SOL-22 est utilisé. La procédure complète
est dans `docs/runbooks/quality-intelligence-sol22-migration.md`.

# 2026-08-14 — API contract and signed outbound webhooks (SOL-28)

`20260814_api_contract_webhooks_sol28.sql` adds the encrypted subscription,
minimal event projection, delivery/retry/dead-letter, idempotency receipt and
append-only audit boundary described by ADR-0074. Run the matching preflight
after a verified encrypted backup, apply only the immutable registered patch,
then run the verify script and an idempotent replay. Rollback is allowed only
before any subscription, delivery, command receipt or audit evidence exists;
after use, disable the worker and preserve evidence.

# 2026-08-14 — Identification industrielle versionnée (SOL-30)

`20260814_identification_labels_sol30.sql` ajoute le registre d’étiquettes, les événements d’impression et de scan, les reçus idempotents et l’audit append-only. Le contenu imprimé est limité à `CERP:1:<public UUID>` et seul son SHA-256 est enregistré lors d’un scan. Exécuter le preflight après une sauvegarde chiffrée vérifiée, appliquer uniquement le patch immuable, exécuter le verify puis un rejeu. Le rollback SQL refuse de supprimer des preuves ; après première utilisation, désactiver les routes et conserver les tables.

# 2026-08-14 — Portail client isolé (SOL-29)

`20260814_client_portal_sol29.sql` ajoute les identités portail séparées des utilisateurs ERP, les jetons à usage unique, reçus idempotents, publications GED explicites, accusés et audits append-only, limites d’authentification persistées et trois projections commerciales en liste blanche. Le trigger `trg_client_portal_ack_tenant_guard_sol29` refuse aussi un accusé entre deux clients différents. Exécuter le preflight après une sauvegarde vérifiée, appliquer seulement le patch immuable, lancer le verify puis un replay. Le rollback est autorisé uniquement avant toute preuve portail ; après usage, désactiver les routes et conserver les données d’audit.
