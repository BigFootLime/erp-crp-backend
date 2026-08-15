# Rapport d'exécution — SOL-41

- Date : 2026-08-15
- Issue : https://github.com/BigFootLime/erp-crp-backend/issues/552
- Branche : `docs/552-sol41-product-scope`
- Base : `origin/main` `3a4566816ccb08b9870837fa1162b2dfb0449e8a`
- Verdict : **garde-fous adoptés, aucun runtime ajouté**

## Diagnostic et cause racine

Les ADR récents bornaient plusieurs capacités risquées, mais la règle transversale
d'acceptation, de financement, de mesure du support et de retrait n'était pas
regroupée. Le risque était de réouvrir séparément les mêmes décisions et de créer des
variantes durables sans propriétaire.

## Choix d'architecture et produit

`ADR-0086` impose quatre issues explicites : noyau commun, extension financée sans
fork, expérience bornée ou non-intégration. La grille ne produit pas de score
magique : sécurité, exploitation, données, tests et sortie restent bloquants.

Le cycle de vie décrit la transformation d'une demande spécifique, la revue
trimestrielle du coût de support et une dépréciation réversible. Les paliers 3, 10 et
20 clients sont conditionnés par des preuves d'exploitation, pas par le volume seul.

Les variables du helper Project Office ne sont pas configurées dans ce checkout ;
aucun secret n'a été lu et aucune écriture implicite n'a été tentée. L'issue GitHub
#552, la branche et la PR constituent la trace de travail disponible pour ce lot.

## Fichiers modifiés

- `docs/adr/ADR-0086-product-scope-governance.md` ;
- `docs/product/FEATURE_ACCEPTANCE_GRID.md` ;
- `docs/product/EXTENSION_LIFECYCLE.md` ;
- `docs/execution-reports/SOL-41.md`.

## Données, migrations et compatibilité

Aucune migration, configuration, feature flag runtime, dépendance ou donnée n'est
modifiée. La règle s'applique aux nouvelles décisions ; elle ne requalifie pas
silencieusement les engagements existants.

## Tests et preuves

| Contrôle | Résultat |
|---|---|
| couverture des neuf axes demandés | PASS — 9 gates sur 9 |
| non-priorités explicites | PASS — 6 catégories sur 6 |
| paliers 3 → 10 → 20 clients | PASS — 3 gates documentés |
| validation UTF-8 et liens relatifs | PASS — 4 fichiers sur 4 |
| `git diff --check` | PASS |

Les tests runtime, SQL, navigateur et E2E sont non applicables à ce diff purement
documentaire. SOL-43 exécutera séparément le contrôle de release sur le commit propre.

## Risques et rollback

Le principal risque est organisationnel : une grille non liée aux décisions n'a pas
d'effet. L'issue, la PR et les revues trimestrielles fournissent la trace minimale ;
les prochaines évolutions significatives devront joindre leur décision.

Le rollback technique consiste à revenir sur le commit. Un remplacement de la règle
requiert cependant un nouvel ADR afin de ne pas recréer une gouvernance implicite.

## Reste réellement à faire

1. Appliquer la grille à la prochaine demande fonctionnelle significative.
2. Mesurer le premier trimestre complet par module avant d'arbitrer une suppression.
3. Revoir formellement les gates avant le passage de 3 à 10 clients.
