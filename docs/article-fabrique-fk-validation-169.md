# Validation des références vers les articles fabriqués — issue #169

## Constat

Le patch historique `20260319_articles_domain_subtypes.sql` a créé trois clés
étrangères avec `NOT VALID`. Cette forme protégeait immédiatement les nouvelles
écritures sans bloquer la migration sur d’éventuelles lignes historiques :

- `commande_ligne.article_id` ;
- `commande_cadre_release_ligne.article_id` ;
- `ordres_fabrication.article_id`.

Les trois références ciblent `articles_fabrique.article_id`.

## Décision

Le contrôle du 2026-07-27 trouve zéro référence invalide dans les trois tables
sur `cerp_test` et `cerp_prod`. Le patch
`20260727_validate_article_fabrique_references_169.sql` valide donc uniquement
ces trois contraintes.

Le patch ne crée, ne modifie et ne supprime aucune ligne métier. Il est
transactionnel, idempotent et limité à `cerp_test` et `cerp_prod`.

## Procédure

1. exécuter le préflight en lecture seule ;
2. vérifier que les trois volumes `invalid_references` valent zéro ;
3. appliquer le patch sur `cerp_test` ;
4. exécuter la vérification et le rollback test-only ;
5. réappliquer et vérifier ;
6. sauvegarder `cerp_prod`, puis répéter préflight, patch et vérification ;
7. comparer les empreintes canoniques des données avant et après.

Le rollback est volontairement interdit sur `cerp_prod`. Sur `cerp_test`, il
recrée les mêmes contraintes avec `NOT VALID` sans toucher aux données.

## Validation réalisée le 2026-07-27

- les trois préflights signalent zéro référence invalide ;
- application, rollback test-only et réapplication réussis sur `cerp_test` ;
- sauvegarde production avant validation :
  `/var/backups/cerp/cerp_prod_20260727-015848.dump`,
  39 332 461 octets, SHA-256
  `d38946dbe325a5c9928780dc5455b5871c90eef0f978ecd5cd1409aefc6b104c` ;
- patch appliqué avec l’empreinte
  `1fb52ce37a096a28b057244aadad00d1d5cc0f98a93ae14e32e7d49249fa15f1`
  et enregistré dans `cerp_schema_migrations` ;
- les 302 tables métier comparées ont exactement les mêmes volumes et
  empreintes avant et après la validation ;
- toutes les clés étrangères du schéma `public` sont validées.

La sauvegarde finale de production utilisée pour reconstruire `cerp_test` est
`/var/backups/cerp/cerp_prod_20260727-020006.dump`, 39 332 474 octets,
SHA-256
`84a63ded269c134a1ad83e6dc734d2afe0547809c276697cfa3e6f80aa6bed2b`.
Les 303 tables de la nouvelle `cerp_test` sont identiques à `cerp_prod`.
