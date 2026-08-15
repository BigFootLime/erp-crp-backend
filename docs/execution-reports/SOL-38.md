# Rapport d'exécution — SOL-38

- Date : 2026-08-15
- Issue : https://github.com/BigFootLime/erp-crp-backend/issues/543
- Branche : `docs/543-sol38-maintenance-oee-gate`
- Base : `origin/main` `a4842b7272900854a3ed80dc7ec6d81389b8c7d7`
- Verdict : **GMAO ciblée déjà présente ; NO-GO télémétrie/OEE**

## Diagnostic et cause racine

Le besoin de maintenance n'exige pas un nouveau module : le parc machines gère déjà
plans, compteurs, échéances, checklists, événements, indisponibilités Planning, RBAC,
audit et concurrence. Le blocage est l'absence de données terrain et de besoin
financé pour une machine connectée.

La production possède 12 machines actives mais aucune ligne opérationnelle dans ce
socle. Aucun pointage n'est disponible pour estimer honnêtement marche, arrêts,
cadence ou qualité. Le calcul existant renvoie donc volontairement un OEE nul au sens
de disponibilité de donnée (`value=null`), jamais un taux de 0 %.

## Preuves examinées

- `20260722_machine_park_165.sql`, routes et repository : plans de maintenance,
  événements append-only, indisponibilités reliées au Planning, RBAC et audit ;
- `production-execution.repository.ts` et ses tests : OEE non calculable quand
  calendrier ou cadence nominale manque ;
- ADR-0031 : aucune machine CERP+ connectée, aucune passerelle ou simulation ;
- transaction PostgreSQL `BEGIN READ ONLY` sur `cerp_prod` : 12 machines actives,
  0 plan, 0 événement maintenance, 0 indisponibilité, 0 pointage total ou machine ;
- catalogue PostgreSQL : aucune table machine de télémétrie, observation, compteur
  ou OEE (`article_observations` est hors périmètre machine).

## Choix d'architecture

`ADR-0083` conserve le module ciblé existant et définit les données minimales du
TRS : ouverture planifiée, arrêts, marche, cadence, total, bon Qualité et lien OF.
Il impose source, fraîcheur, couverture et qualité par composante. L'absence d'une
preuve rend le taux non calculable.

La future connectivité reste limitée à une machine et un client financés, via la
passerelle locale en pull d'ADR-0031, sans commande machine depuis l'ERP.

## Fichiers, migrations et données

- `docs/adr/ADR-0083-maintenance-oee-machine-data-gate.md` ;
- `docs/execution-reports/SOL-38.md`.

Aucun code, endpoint, adaptateur, migration, fixture ou donnée n'est ajouté. Aucun
plan de maintenance réel n'est inventé pour les douze machines.

## Tests et vérifications

| Contrôle | Résultat |
|---|---|
| inventaire code/ADR/issues | PASS |
| introspection production read-only | PASS — `12 / 0 / 0 / 0 / 0` |
| tests ciblés parc/exécution/OEE | PASS — 5 fichiers, 252 tests |
| validation UTF-8 des Markdown | PASS — 2/2 |
| `git diff --check` | PASS |

Aucun test navigateur n'est applicable au diff documentaire. Les tests actuels de
l'écran et de l'API vérifient déjà que l'OEE indisponible reste visible et n'est pas
converti en zéro. Le premier lancement a détecté un `node_modules` local incomplet ;
`pnpm install --frozen-lockfile` l'a reconstruit sans modifier le lockfile avant le
rejeu réussi.

## Risques et compatibilité

- Le parc décrit ne prouve pas les durées de fonctionnement ou les alarmes.
- Un compteur de cycles ne prouve pas la conformité ; Qualité reste autoritaire.
- Les valeurs issues d'un futur pilote ne pourront pas être extrapolées aux onze
  autres machines sans qualification séparée.
- Le comportement actuel et le planning restent inchangés.

## Rollback

Revenir sur le commit documentaire retire seulement l'ADR et ce rapport. Aucun
rollback applicatif ou SQL n'est requis.

## Reste réellement à faire

1. Faire valider et saisir les plans réels, compteurs, échéances et responsables.
2. Obtenir le financement et choisir une machine/protocole pilote réels.
3. Collecter puis qualifier les événements avec le rapport ADR-0083.
4. Activer le calcul OEE seulement lorsque chaque composante atteint le seuil
   contractuel ; sinon conserver `non calculable`.
