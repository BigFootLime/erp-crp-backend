# SOL-06 — Centre guidé de préparation de la production

- Date : 2026-08-11
- Branche : `feature/543-production-readiness-center`
- Base : `origin/dev`
- Ticket : [BigFootLime/crp-systems-web#543](https://github.com/BigFootLime/crp-systems-web/issues/543)
- Environnement : worktrees dédiés, PostgreSQL 16 jetable sur loopback
- Production : aucune connexion ni écriture

## Diagnostic et cause racine

Le gate SOL-06 refusait correctement certains flux incomplets, mais les utilisateurs n'avaient ni vue centrale ni navigation directe pour fournir les calendriers, centres de frais et taux manquants. En outre, le preflight traitait l'absence de ces valeurs métier comme un défaut empêchant d'installer le correctif lui-même.

La cause racine était la confusion entre deux natures de prérequis : la structure technique indispensable à une migration et les décisions métier réelles que seule l'entreprise peut déclarer. Préremplir ces dernières aurait fabriqué capacité et valorisation. La recette navigateur a aussi détecté que l'API renvoyait `updated_at` au format texte PostgreSQL tout en exigeant ISO-8601 au retour ; les timestamps sont désormais normalisés dans le DTO.

## Choix d'architecture

- endpoint autoritaire `GET /api/v1/production/readiness`, compatible avec le gate v1 pendant la transition ;
- nouvelle fonction SQL v2 additive, sans donnée de démonstration ;
- blocage des écritures critiques maintenu côté base ;
- RBAC serveur distinct pour lecture, calendriers, centres de frais et tarifs ;
- création calendrier et fermeture idempotentes, mise à jour avec verrou optimiste ;
- audit transactionnel de toute mutation réelle ;
- métadonnées décisionnelles obligatoires : définition, unité, période, source, fraîcheur et fiabilité ;
- taux courant strictement positif : zéro représente une valeur absente, jamais un coût réel ;
- SHA de release injecté dans `CERP_RELEASE_VERSION` pour Coolify et les builds HYPERBOX2.

La décision complète est consignée dans `docs/adr/ADR-0060-production-readiness-center.md`.

## Fichiers modifiés

- `src/module/production-readiness/` : politique RBAC, validations, dépôt, service, contrôleurs et routes ;
- `src/routes/v1.routes.ts`, `src/module/access-control/domain/module-catalog.ts` : montage et catalogue ;
- `src/module/methodes/validators/methodes.validators.ts` : refus des taux nuls ;
- `db/patches/20260811_production_readiness_center.sql` et fichiers `support/` : preflight, vérification et rollback test-only ;
- `db/patches/support/20260810_system_reference_data_readiness.preflight.sql` : séparation structure/donnée métier ;
- `scripts/db-patches.js` : empreinte immuable du nouveau patch ;
- `Dockerfile` : propagation de `SOURCE_COMMIT` vers la version runtime ;
- tests de routes, RBAC, validations, migration et contrat Dockerfile ;
- ADR, runbooks et présent rapport.

## Migration et données

Le patch est additif. Il crée `fn_business_prerequisite_status_v2`, remplace la fonction d'enforcement par une version fondée sur v2 et attribue les droits minimaux au rôle applicatif. Il ne crée ni calendrier, ni centre de frais, ni taux.

Empreinte enregistrée : `2657f0f1eeca1a708a32ec41ae4c2a9eb2755df074d0a7984ccebcfce6b2dde5`.

Preuve isolée PostgreSQL 16 : le rehearsal reconstruit l'état à 140 patches, sauvegarde 1 954 228 octets, applique la chaîne complète jusqu'à 145, rejoue à zéro patch, vérifie l'intégrité, prouve le refus SQLSTATE `P2606`, le rollback test-only et une restauration dans une base neuve avec empreinte identique. Avant seed, les deux prérequis restent explicitement faux. Après seed déterministe, les cinq prérequis Production sont vrais. Le conteneur jetable a été détruit.

## Tests exécutés

| Commande/scénario | Résultat réel |
|---|---|
| Test ciblé `production-readiness-543.test.ts` | 10/10 réussis |
| Suite backend Vitest complète | 267 fichiers réussis, 4 442 tests réussis, 4 ignorés |
| `pnpm run build` | réussi |
| Migration isolée `pnpm e2e:migrate:isolated` | 145 appliqués, 0 pending, 0 mismatch |
| Vérification SQL avant/après seed | structure valide ; manque honnête puis 5/5 prêts |
| Rollback test-only puis réapplication | réussi |
| `pnpm run db:migrations:rehearse` | réussi ; sauvegarde/restauration cohérente, 140 → 145 patches |

## Vérification navigateur / E2E

Le scénario Playwright Chromium exécute un vrai build frontend et une API reliée à PostgreSQL jetable. Il désactive les calendriers du seed, vérifie le blocage avec métadonnées, la navigation directe, l'absence de valeurs horaires préremplies, la création explicite, le retour à l'état prêt puis le retry identique sans doublon. Un premier passage a révélé puis permis de corriger le format `updated_at`; résultat final : 1/1 réussi en 7,3 s, 0 retry ; exécution isolée totale 66,3 s.

## Risques et compatibilité

- La fonction v2 revient temporairement à v1 si le patch n'est pas encore présent, ce qui permet de livrer le backend avant la migration.
- Les valeurs réelles doivent toujours être déclarées par l'entreprise pilote. Tant qu'elles manquent, les lancements protégés sont volontairement refusés.
- Le modèle d'isolation actuel est une base distincte par société/environnement ; un futur multi-tenant dans une base exigerait un `tenant_id` explicite.
- Coolify doit activer **Include Source Commit in Build** ; un build manuel doit passer `--build-arg SOURCE_COMMIT=<sha>`.

## Rollback

Avant production : sauvegarde vérifiée, artefacts précédents conservés et preflight lecture seule. En cas d'échec, restaurer la sauvegarde dans une base neuve, exécuter les contrôles d'intégrité, basculer `DATABASE_URL`, puis redéployer les artefacts précédents. Le rollback SQL fourni n'est autorisé que sur `cerp_test` avec `cerp.migration_rehearsal=on`.

## Restant réellement à faire

1. Faire saisir et valider par les responsables les calendriers et taux réels de chaque base cible.
2. Avant toute écriture production, exécuter sauvegarde, empreinte, preflight et fenêtre opérateur sur chaque base.
3. Activer l'injection `SOURCE_COMMIT` dans Coolify et contrôler `/health/live.version` après redéploiement.

Ces actions touchent l'environnement ou les données de production et ne sont pas exécutées automatiquement depuis ce worktree.
