# Rapport d'exécution — SOL-01

Date : 2026-08-09

Dépôt : `erp-crp-backend`

Branche : `integration/sol-01-release-baseline`

Rapport de référence : [`docs/release/BASELINE_RECONCILIATION.md`](../release/BASELINE_RECONCILIATION.md)

## Résultat

Une candidate backend propre a été créée depuis `origin/dev` à `f0ee00817980136fd0dae6a7c9c6d45aaab06503`. Elle contient le provisioning sécurisé `2dcae2c` et deux corrections de tests qui conservent les contrats réels, `bb04318` et `c6643e9`. Elle n'a pas été poussée. Les 121 worktrees préexistants ont été inventoriés ; les 7 arbres sales ont chacun une branche de sécurité et sont restés inchangés. Avec la candidate SOL-01, le total final est 122.

## Diagnostic et cause racine

Le checkpoint backend actif avait 440 commits de retard. Une version fonctionnellement équivalente avait déjà été reconstruite sur le canonique, tandis que des migrations et fonctions métier plus anciennes restaient dispersées dans des worktrees. Le conflit principal n'est pas textuel : l'ancien correctif GED et le provisioning actuel désignent deux autorités différentes pour l'accès.

## Choix d'architecture

- Construire depuis `origin/dev`, non depuis le WIP actif.
- Réserver la création de compte à une route admin authentifiée avec RBAC, validation, audit et idempotence.
- Préserver la frontière compte/module ; ne pas restaurer implicitement des rôles nommés comme autorité GED.
- Tester toute migration avec preflight, sauvegarde, vérification et rollback dans PostgreSQL jetable.

## Fichiers modifiés

- `db/patches/20260803_admin_user_provisioning_boundary.sql`
- les trois scripts `db/patches/support/20260803_admin_user_provisioning_boundary.{preflight,rollback,verify}.sql`
- cinq nouveaux tests `admin-user-provisioning.*.test.ts`
- tests auth, multi-rôle et socket ACL existants
- contrôleurs, repositories, routes, services et validateurs des modules `admin` et `auth`
- le présent rapport et le rapport de réconciliation.

## Migration et données

La migration a été qualifiée intégralement dans PostgreSQL 16 jetable avec sauvegarde relisible, forward, verify et rollback. Les résultats sont détaillés dans le rapport principal. Aucune connexion ou écriture production.

## Tests

- `npm run build` : succès (`tsc -p tsconfig.json`).
- suite complète : 250 fichiers réussis, 1 ignoré ; 4 350 tests réussis, 4 ignorés.
- provisioning ciblé : 23/23 ; garde migration : 31/31 ; multi-rôle/validation : 16/16 ; socket ACL : cinq passages à 31/31.
- aucun script lint n'existe ; lint non exécuté et non présenté comme vert.

## Navigateur / E2E

La preuve publique frontend passe 1/1. La suite complète donne 10 réussis, 16 échoués et 29 ignorés faute d'environnement authentifié complet, dont `E2E_PASSWORD`. La candidate backend ne peut donc pas être déclarée qualifiée E2E globalement.

## Risques, compatibilité et rollback

Le risque P0 est la convergence du cloisonnement GED avec le module gate. `npm audit` signale aussi cinq vulnérabilités hautes. La branche n'étant pas publiée, revenir à `f0ee008` suffit. Après publication, utiliser des reverts ; pour la migration, restaurer ou exécuter le rollback fourni seulement après le protocole préflight/sauvegarde/validation.

## Restant

1. ADR et implémentation atomique de l'autorisation GED frontend/backend.
2. Qualification Playwright complète dans un environnement jetable authentifié.
3. Remédiation des dépendances hautes depuis le lockfile courant.
4. Rebase thématique des lots métiers conservés sur les branches de sécurité.
