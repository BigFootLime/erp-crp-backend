# SOL-24 — Affaires, Project Office, temps et déplacements (backend)

- Date : 2026-08-14
- Propriétaire : Keenan Martin
- Issue : [#462](https://github.com/BigFootLime/erp-crp-backend/issues/462)
- Branche : `feature/462-sol24-project-operations`
- Base initiale : `origin/main` (`ad46ce5639523f5d59c9f5216e6fb11cdae5f09f`)
- ADR : `docs/adr/ADR-0070-project-operations-and-hr-control-boundary.md`

## Diagnostic et cause racine

Les projets contenaient lots, jalons, dépendances et risques, mais pas de budget
versionné ni de provenance financière vers les affaires. Le temps RH distinguait
les pointages de production, mais l'absence explicite, les périodes closes, les
taux kilométriques datés et la file d'exceptions n'étaient pas représentés.
Plusieurs validations reposaient encore sur un rôle trop large et autorisaient
potentiellement l'auto-approbation.

La première recette PostgreSQL réelle a trouvé deux défauts que les repositories
mockés ne pouvaient pas révéler : `/projects` envoyait un paramètre sans placeholder
en contexte administrateur (`08P01`) et la détection de doublons appelait
`min(uuid)`, fonction absente (`42883`). Les requêtes ont été corrigées à la
source et couvertes par des contrats de repository et l'E2E réel.

## Architecture livrée

- budget Project Office append-only, daté, sourcé et audité ;
- liens projet → affaire explicites et anti-doublon ;
- consommé issu exclusivement du moteur de marge réel ; un coût partiel n'est
  jamais soustrait comme complet ;
- heures, jalons en retard, dépendances bloquantes, burn-up douze semaines et
  matrice de risques avec définition, source, fraîcheur et fiabilité ;
- absences demandées/décidées, clôtures avec preflight, taux kilométriques datés
  et coût photographié sur l'entrée validée ;
- file d'action manager/RH et règles salarié/manager/admin fail-closed ;
- interdiction d'auto-approbation pour absences, corrections, feuilles et km.

Le burn-up reste `ESTIMATED` parce que le schéma ne conserve pas encore une date
historique immuable de terminaison. L'absence de coût, taux, affaire ou heures est
retournée comme donnée manquante, jamais comme zéro.

## Fichiers modifiés

- `src/module/project-office/` : contrôleur, service, repository, validation,
  routes et correction du contrat de liste ;
- `src/module/temps-deplacements/` : politique de domaine, opérations, absences,
  clôtures, taux, valorisation km, corrections, types et routes ;
- `db/patches/20260814_project_operations_sol24.sql` et trois scripts support ;
- runner de patch, release gate SOL-06 et seed E2E isolé ;
- `Dockerfile` : le runner et l'inventaire canonique des migrations sont embarqués
  dans l'image et restent ainsi liés au SHA réellement déployé ;
- tests SOL-24 et adaptations T4/T6 ;
- ADR-0070 et présent rapport.

## Migration et données

Le patch est additif : cinq tables, trois colonnes de snapshot kilométrique,
contraintes, index et triggers de cohérence. Il ne crée aucun budget, taux,
absence, clôture ou coût métier. Le seed SOL-24 est conditionné à la présence du
schéma et au garde `cerp_test` local du runner E2E.

Répétition PostgreSQL 16 jetable du 14/08/2026 : **155 patchs appliqués, zéro en
attente, zéro checksum divergent**. Sauvegarde, vérification, rollback test-only,
restauration vers base neuve, empreinte source/restaurée identique et rejeu à
zéro patch ont réussi. Le dump de répétition faisait 1 968 391 octets, SHA-256
`a5a0f52a892441d755aae43babfbc0e433696e60172cc337bd2680c71314bf7d`.

La fenêtre réelle a utilisé deux dumps PostgreSQL 17 vérifiés par
`pg_restore --list`, stockés en mode `0600` :

- `cerp_test_pre_sol24.dump` : 72 939 037 octets, SHA-256
  `3f0e8349312ea75d887cf672c22cef3795ec20c52f588a36393b747d6654df83` ;
- `cerp_prod_pre_sol24.dump` : 49 449 264 octets, SHA-256
  `b92f65fa94e5086e343fc31322d5bed4999cdf82ca35f6fd4edb33901a75d1f4`.

Le patch `20260814_project_operations_sol24.sql`, SHA-256
`e978abeb2b6758744d3824540b2552ef6b6ca90f0c634bc49dd7af403d4e8cd9`, a
été appliqué par `--only` d'abord sur `cerp_test`, puis sur `cerp_prod` après
leurs preflights. Registre final : test 135 appliqués/20 en attente/0 checksum
divergent ; production 130 appliqués/25 en attente/0 checksum divergent. Les
deux scripts de vérification donnent zéro orphelin, zéro version budgétaire
active en chevauchement et zéro coût kilométrique sans taux.

## Tests exécutés

| Contrôle | Résultat réel |
|---|---|
| tests SOL-24 ciblés | PASS — 4 fichiers, 16/16 après correctif SQL |
| suite backend complète | PASS — 306 fichiers, 4 621 tests ; 4 tests optionnels ignorés |
| typecheck backend | PASS |
| build + frontière données production | PASS — 680 fichiers runtime/émis |
| audit dépendances production | PASS — aucune vulnérabilité connue |
| répétition migration SOL-06 | PASS — backup, rollback, restauration, rejeu |
| E2E Chromium isolé SOL-24 | PASS — 3/3, sans retry, 12,2 s de tests |
| contrat image/migrations | PASS — 1 fichier, 7/7 |

L'E2E a réellement créé PostgreSQL, appliqué 155 migrations, chargé huit comptes
déterministes, construit le frontend, démarré l'API, vérifié Project Office,
l'absence, l'administration RH et le refus d'un salarié standard, puis détruit
la pile. Les deux premiers passages ont respectivement découvert les défauts SQL
et des locators ambigus ; aucun timeout ni assertion métier n'a été assoupli.

## Navigateur

Le navigateur intégré a vérifié la pile jetable sur `127.0.0.1` : budget 25 000
EUR et source déclarée, coût/restant indisponibles sans affaire, temps 20 h/12 h,
jalon en retard, burn-up, matrice des risques, demande d'absence, manque non
justifié, onglets Clôtures et Taux km. Les actions incomplètes restent désactivées.
Aucune erreur console n'a été relevée ; deux avertissements structurés de temps
réel local ont été observés. Les processus et le conteneur ont été supprimés.

Sur le déploiement public, la ressource frontend a bien servi le SHA attendu et
la page Project Office s'est chargée. Le navigateur de contrôle a toutefois
bloqué le domaine API avec `ERR_BLOCKED_BY_CLIENT` ; aucune requête Project
Office correspondante n'est arrivée dans les logs backend corrélés. Cette
limitation du client de recette est explicitement conservée et n'est pas
présentée comme une réussite fonctionnelle production.

## Permissions, audit et compatibilité

- lecture projet : accès projet existant et anti-IDOR ; mutation : owner/manager ;
- salarié : ses propres demandes ; manager : collaborateurs directs ;
  RH/Direction/Administration : périmètre global explicite ;
- décision et création écrivent audit global et, pour Project Office, activité
  projet dans la même transaction ;
- clôture refuse toute exception en attente et bloque ensuite les mutations ;
- aucun nouveau package et aucun changement visuel de design ;
- aucune dimension société/site exploitable n'existe dans ces tables, limite
  explicitement conservée.

## Rollback

Avant données réelles, le script support peut supprimer les objets uniquement
sur `cerp_test`. Après mise en service, redéployer le SHA backend antérieur en
conservant le schéma additif. Si le schéma doit revenir, suspendre les écritures,
restaurer le dump pré-SOL-24 correspondant dans une base neuve, démarrer l'ancien
SHA et vérifier comptages, clés étrangères, authentification, Project Office et
exports RH. Les deux empreintes de dump ci-dessus sont les références de
restauration ; aucun rollback destructif en place n'est prévu.

## Risques et reste réel

- le burn-up historique est estimé tant qu'une date de terminaison immuable
  n'est pas enregistrée ;
- les budgets non EUR ne sont pas convertis faute de source de change qualifiée ;
- la séparation société/site reste à concevoir si le produit devient multi-entité ;
- la recette publique Project Office doit être répétée depuis un navigateur sans
  bloqueur client ;
- l'application autonome HYPERBOX2 n'a pas de chemin d'administration authentifié
  disponible dans cette exécution. La base PostgreSQL HYPERBOX2, jointe par le
  conteneur Coolify sur `10.90.0.2`, a en revanche bien été migrée et vérifiée.

## Promotion et exploitation

- commit fonctionnel : `f83301b4d3754757f06b86fe30ab46d6d167dce9` ;
- commit de contrat d'image : `9819028f2a8fd439f06f95dafd580b2061be5e50` ;
- PR [#463](https://github.com/BigFootLime/erp-crp-backend/pull/463) fusionnée
  vers `dev` (`e38060ab0fc6fc1cce3e66e61ed258278112a11e`) ;
- PR [#465](https://github.com/BigFootLime/erp-crp-backend/pull/465) fusionnée
  vers `dev` pour le contrat d'image (`8e52df78a7faefd783882736517921c5572ecede`) ;
- PR [#464](https://github.com/BigFootLime/erp-crp-backend/pull/464) fusionnée
  vers `main`, SHA `2803a5e5eddc0c0e312cff0196965cbbfe1ff12a` ;
- premier déploiement Coolify `d61qtlrr4faczhtsjov46r3j` échoué au preflight
  `upload_storage` : les dumps créés pour la fenêtre étaient les seuls objets
  `root:root` du volume ;
- après revalidation des deux checksums, seul leur propriétaire a été corrigé
  vers `1000:1000`, sans modifier leur contenu ;
- redéploiement `y7vnii1txe57cs7ijy53v5zl` réussi du 14/08/2026 08:39:59 UTC
  au 14/08/2026 08:43:14 UTC, durée 3 min 15 s ;
- conteneur final `rcccokw0wgcw0ck44g0wk0ck-083959486455`, `running
  (healthy)`, `/health/live` et `/health/ready` à 200, version exposée
  `2803a5e5eddc0c0e312cff0196965cbbfe1ff12a`.

## Patchs antérieurs non intégrés à cette fenêtre

Ils sont volontairement séparés de SOL-24 : les appliquer en lot contournerait
leurs preflights, dépendances et décisions métier. `cerp_test` conserve 20 patchs
en attente et `cerp_prod` 25. Les cinq patchs présents uniquement dans la file
production sont `20260726_import_assistant_167.sql`,
`20260727_admin_access_tower_326.sql`, `20260727_contacts_email_scope_187.sql`,
`20260727_import_clients_enrichment_306.sql` et
`20260729_surface_finish_library_admin_226.sql`.

Les 20 patchs communs encore à qualifier sont :

```text
20260710_hr_users_role_responsable_rh.sql
20260723_stock_traceability_225.sql
20260724_expedition_deliveries_226.sql
20260725_qualite_360_228_runtime_access.sql
20260726_metrologie_360_229.sql
20260727_contacts_shared_email_identity_190.sql
20260727_import_supplier_orders_312.sql
20260727_stock_import_precision_198.sql
20260727_user_account_profile_optional_315.sql
20260727_user_multi_roles_315.sql
20260730_account_module_access_262.sql
20260730_piece_technique_family_nullable_413.sql
20260730_piece_technique_pf_internal_family_404.sql
20260730_repair_module_catalog_visibility_402.sql
20260730_surface_finish_family_comment_244.sql
20260811_margin_traceability_0002.sql
20260812_procurement_reliability_sol18.sql
20260813_sol20_tooling_technical_ged.sql
20260813_stock_intelligence_sol19.sql
20260814_planning_execution_intelligence_0021.sql
```

## Traçabilité de pilotage

Le canal Project Office externe n'est pas configuré ; l'issue GitHub #462 est la
trace canonique de cette exécution. Aucune preuve de synchronisation externe
n'est inventée.
