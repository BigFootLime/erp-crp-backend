# SOL-05 — Rapport d'exécution backend

## Statut

Prêt à fusionner sur `fix/sol-05-isolated-e2e`. Aucun accès ni écriture production n'a été effectué. Le backend participe à une pile PostgreSQL tmpfs entièrement jetable pilotée par le frontend.

## Diagnostic et cause racine

Le ledger de 139 patches est additif et suppose un schéma historique qui n'existe pas dans une base PostgreSQL vide. Une fois cette frontière reconstruite, l'exécution réelle a révélé plusieurs écarts SQL que les mocks ne voyaient pas : arité de paramètres, colonnes historiques, types UUID/booléen, sous-type `articles_fabrique`, transitions de réception/qualité/livraison et clauses finance/reporting.

Le panneau admin lisait aussi trois colonnes historiques de `users` absentes du bootstrap réduit. `db/e2e/historical-runtime-contract.sql` restaure et vérifie `profile_picture`, `last_login` et `created_at` pour empêcher le retour d'une liste utilisateurs bloquée sur « Chargement… ».

## Choix d'architecture

- `scripts/e2e/migrate-isolated.js` refuse toute base autre que `cerp_test` isolée, rejoue le ledger et valide les checksums.
- `db/e2e/legacy-bootstrap.sql`, `normalize-empty-uuid-spine.sql` et `historical-runtime-contract.sql` reconstruisent uniquement la frontière historique nécessaire à la pile jetable.
- `scripts/e2e/seed-isolated.js` crée sept identités déterministes et les référentiels minimaux.
- `src/config/e2e-isolation.ts` et `src/index.ts` imposent le fail-closed au démarrage.
- La corrélation des mouvements de stock est persistée par migration avec preflight, verify et rollback, afin de prouver l'idempotence des actions critiques.

## Fichiers modifiés

- Isolation : `package.json`, `src/index.ts`, `src/config/e2e-isolation.ts`, `scripts/e2e/*`, `db/e2e/*`.
- Migration : `db/patches/20260810_stock_movement_event_correlation.sql` et ses scripts `support/*.preflight.sql`, `*.verify.sql`, `*.rollback.sql`.
- Commandes/devis : repositories commande client et devis, tests de routes associés.
- Production/qualité/stock : repositories production, réception, qualité, livraison et leurs tests.
- Finance/reporting : facture, avoir, reporting v2 et tests de contrat SQL.
- Métrologie : registry et test route 360.
- Tests de sécurité/contrat : isolation E2E et garde de migration de corrélation.
- Documentation : présent rapport.

## Migration et stratégie données

`20260810_stock_movement_event_correlation.sql` ajoute le support de corrélation au journal d'événements de stock. Avant un déploiement persistant :

1. exécuter le preflight fourni ;
2. sauvegarder la table concernée avec `pg_dump` ;
3. appliquer la migration ;
4. exécuter le verify ;
5. en cas d'échec, restaurer la sauvegarde ou appliquer le rollback après validation qu'aucune corrélation créée depuis ne doit être conservée.

Les scripts `db/e2e/*` et le seed sont strictement réservés à `cerp_test` avec `cerp.e2e_isolated=on` et ne constituent pas des migrations production.

## Tests exécutés

- Suite backend complète : 877 suites ; 4 391 tests total, 4 387 réussis, 0 échec, 4 pending.
- Commandes ciblées : 39/39.
- Build TypeScript : succès en 9 s.
- Replay isolé : 139 patches appliqués, 0 pending, 0 checksum mismatch.
- Validation intégrée frontend/backend : 61/61 scénarios Playwright, 0 retry.

## Vérification navigateur

Sur la pile locale : badge `cerp_test (test)`, Dashboard et Commandes Clients chargés. Le panneau Administration a listé les sept comptes et le menu KEENAN a ouvert le dialogue de réinitialisation du mot de passe. Aucun mot de passe n'a été appliqué.

## Risques et compatibilité

- Les correctifs SQL conservent les API publiques ; ils alignent les repositories sur PostgreSQL réel.
- Quatre tests backend restent explicitement pending, sans échec et sans désactivation ajoutée par SOL-05.
- Le contrat historique E2E documente une dette : certains éléments antérieurs au ledger ne sont pas encore représentés comme migration de création complète. Il est isolé du chemin production.

## Rollback

Revert du commit backend SOL-05. Pour la migration de corrélation, suivre la procédure preflight/sauvegarde/rollback ci-dessus. Pour les tests, la suppression du conteneur tmpfs et des répertoires temporaires suffit ; aucune donnée persistante n'existe.

## Reste réel

Aucun défaut backend bloquant ni échec E2E restant. La consolidation future du schéma historique en baseline versionnée peut être traitée séparément sans bloquer cette release.
