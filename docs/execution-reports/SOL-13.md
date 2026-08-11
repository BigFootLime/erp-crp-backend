# SOL-13 — Coûts industriels et marges traçables (backend)

Date : 2026-08-11
Branche : `fix/405-sol-13-margin-traceability`

## Diagnostic et cause racine

Le moteur opposait seulement `PLANNED` et `ACTUAL`, sans distinguer devis, standard daté et actualisé. Les preuves ne portaient pas systématiquement définition, unité, période, fraîcheur et fiabilité. Certaines quantités absentes pouvaient être transformées en zéro par des agrégats SQL, et les rebuts/retouches ou réceptions fournisseur n'étaient pas reliés à une preuve suffisamment explicite.

## Choix d'architecture

`CERP-MARGIN-2.0.0` est l'unique calcul autoritaire. Il publie `QUOTED`, `STANDARD`, `UPDATED`, `ACTUAL`, les statuts `ESTIMATED|PARTIAL|ACTUAL`, deux écarts serveur et un waterfall serveur. `ACTUAL` exige un calcul complet composé uniquement de preuves `VERIFIED`. Une entrée manquante maintient coût, marge et ratios à `null`.

Les paramètres et entrées restent append-only et datés. Le contrat de preuve v2 exige définition, unité, période, fiabilité et document source pour une preuve vérifiée. Les anciennes preuves v1 restent lisibles sans être réécrites.

## Fichiers modifiés

- domaine, repository, service et validateurs de `src/module/margin-engine/`;
- politiques de marge différée du reporting facturation;
- tests numériques, RBAC, contrat, CSV et garde-fous de migration;
- patch `db/patches/20260811_margin_traceability_0002.sql` et son trio preflight/verify/rollback;
- `scripts/migrations/release-gate.js` pour exercer réellement le rollback SOL-13;
- ADR-0061, runbook opérateur et audit exhaustif des usages.

## Migration et données

Le patch ajoute uniquement métadonnées et contraintes aux tables de marge; aucune valeur métier existante n'est réécrite. Il conserve `PLANNED` pour l'historique et autorise les quatre bases nouvelles ainsi que `REWORK`.

La répétition PostgreSQL jetable finale a appliqué 6 patches, dont SOL-13 (SHA-256 `8639afd24dfbf6ecd49131d2247c506ec1ca7acc17346bfdbacb61aaf6582d61`), avec : sauvegarde 1 954 315 octets (SHA-256 `e1bdb51992d8b683124b1d45aababa1c51233726d4a624f4edeb890ea678091d`), preflight, intégrité, verify, rejeu à zéro, rollback SOL-13 en 56 ms et restauration en 4 038 ms. Le contrôle `margin_traceability_removed=true` prouve le retrait des objets SOL-13 avant restauration; les comptages restaurés sont identiques.

La valorisation matière retenue est le CUMP, source : décision du dirigeant Keenan Martin du 11/08/2026, fiabilité `DECLARED`.

## Tests et navigateur

- cœur ciblé backend : 4 fichiers, 27 tests réussis;
- suite backend complète finale : 269 fichiers, 4 453 tests réussis, 4 ignorés, aucun échec;
- le premier passage global a détecté 3 assertions reporting devenues obsolètes; leur contrat a été aligné sur `CROSS_OBJECT_MARGIN_AGGREGATION_NOT_VALIDATED`, puis la suite complète a été rejouée avec succès;
- `npm run typecheck` et `npm run build` réussis; frontière de données validée sur 633 fichiers source et 633 fichiers émis;
- audit production backend : 0 vulnérabilité connue;
- migration isolée : `passed`, 140 → 146 patches, aucun checksum divergent, restauration et rejeu idempotent réussis;
- build réel de la pile E2E : backend et frontend démarrés sur loopback avec `cerp_test` jetable;
- navigateur : connexion KEENAN, devis de preuve, onglet Rentabilité et drill-down vérifiés contre l'API réelle. Les quatre perspectives sont `PARTIAL`, les 48 entrées manquantes sont explicites, la formule et la période sont visibles, coûts et marges complets restent `—`.

## Risques et compatibilité

- Les consommateurs historiques peuvent encore lire les snapshots `PLANNED`; les nouveaux endpoints d'écriture les refusent.
- La marge client agrégée reste volontairement indisponible tant que les allocations, retours, avoirs et frais indirects ne sont pas réconciliés.
- Les rebuts/retouches positifs bloquent une marge complète tant qu'ils ne sont pas valorisés : c'est un garde-fou, pas une panne.
- La migration prend brièvement des verrous exclusifs et abandonne après 5 secondes.

Le premier gate SOL-12 exécuté après fusion sur `dev` a été bloqué avant E2E par un artefact TypeScript ancien resté dans `dist` après le déplacement d'une fixture. Le build nettoie désormais exclusivement le répertoire généré `dist` avant `tsc`; un test garantit que les fichiers voisins ne sont jamais supprimés.

## Rollback

En `cerp_dev`/`cerp_test`, le rollback vérifie le SHA du ledger, prend le verrou de migration, refuse toute preuve v2 ou nouvelle perspective, retire les objets puis supprime exactement l'entrée ledger SOL-13. En production, arrêter les écritures et restaurer le dump pré-migration vérifié; ne pas exécuter un SQL inverse après création de preuves v2.

## Reste réellement à faire

- faire exécuter le gate SOL-12 de promotion sur les commits propres après fusion;
- appliquer la migration sur une base persistante uniquement pendant une fenêtre autorisée avec sauvegarde vérifiée.
