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
restaurer le dump pré-SOL-24 dans une base neuve, démarrer l'ancien SHA et vérifier
comptages, clés étrangères, authentification, Project Office et exports RH.

## Risques et reste réel

- le burn-up historique est estimé tant qu'une date de terminaison immuable
  n'est pas enregistrée ;
- les budgets non EUR ne sont pas convertis faute de source de change qualifiée ;
- la séparation société/site reste à concevoir si le produit devient multi-entité ;
- la promotion, les sauvegardes réelles, l'application aux bases et les
  déploiements sont consignés ci-dessous après exécution.

## Promotion et exploitation

À compléter après promotion contrôlée vers `dev` puis `main`, sauvegardes,
application du patch par checksum immuable et vérifications HYPERBOX2/Coolify.

## Traçabilité de pilotage

Le canal Project Office externe n'est pas configuré ; l'issue GitHub #462 est la
trace canonique de cette exécution. Aucune preuve de synchronisation externe
n'est inventée.
