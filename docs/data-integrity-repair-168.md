# Réparation d’intégrité des catégories d’articles — issue #168

## Diagnostic

Le clonage de `cerp_prod` a révélé deux lignes dans
`article_category_link` pour un même article absent. L’audit de création
`erp_audit_logs.id = 167` est toujours présent et identifie une donnée de
recette. L’article, son projet et sa pièce technique ne sont plus présents.

Un scan de toutes les colonnes de tables métier nommées comme une référence
Article, `entity_id` ou `target_id` a confirmé que seules les deux lignes de
catégorie et l’audit source référencent encore cet identifiant.

La reconstruction de l’Article est refusée : elle nécessiterait d’inventer une
pièce technique et une affaire absentes, ce qui créerait de fausses données
industrielles.

## Réparation

Le patch `20260727_repair_article_category_orphans_168.sql` :

1. verrouille uniquement `article_category_link` pendant la transaction ;
2. vérifie l’identité et les SHA-256 des preuves attendues ;
3. rescane les références Article et refuse tout périmètre élargi ;
4. copie les deux lignes complètes dans `erp_audit_logs` ;
5. retire uniquement ces deux liens résiduels ;
6. valide `article_category_link_article_id_fkey`.

La suppression n’efface donc pas la preuve : le dump préalable, l’audit de
création et l’audit de réparation conservent l’historique complet.

## Procédure

1. exécuter le preflight en lecture seule sur `cerp_test` ;
2. appliquer le patch par le registre de migrations ;
3. exécuter `verify.sql` ;
4. tester le rollback uniquement sur `cerp_test`, puis réappliquer et vérifier ;
5. sauvegarder `cerp_prod` ;
6. répéter preflight, patch et verify sur `cerp_prod` ;
7. recréer `cerp_test` depuis la production corrigée avant le pilote CLIPPER.

Le patch refuse toute base autre que `cerp_test` ou `cerp_prod`. Le rollback
refuse toute base autre que `cerp_test`.

## Validation réalisée le 2026-07-27

- sauvegarde de `cerp_test` avant essai :
  `/var/backups/cerp/cerp_test_pre_168_20260727-0145.dump`,
  39 374 288 octets, SHA-256
  `81ae5e52536d903ef3f53348414b4cb165492758f8274b39f370762617c9043f` ;
- préflight, application, relance idempotente, rollback et réapplication
  réussis sur `cerp_test` ;
- sauvegarde production immédiatement avant correction :
  `/var/backups/cerp/cerp_prod_20260727-015023.dump`,
  39 332 092 octets, SHA-256
  `05804cad344fd222ca7fb506a85c3d9088655001c6afef1c03902951b5649bc2` ;
- patch appliqué avec l’empreinte
  `a480bdadedd9432b831fed1f52f774adef49f91147c2717a845d8037e89ecec3`
  et enregistré dans `cerp_schema_migrations` ;
- `article_category_link` passe de 2 à 0 lignes et `erp_audit_logs` de 202 à
  203 lignes, conformément au périmètre attendu ;
- les nombres de lignes et empreintes des 300 autres tables métier sont
  strictement identiques à la copie de référence ;
- la preuve d’audit, la contrainte ciblée et l’absence de lien orphelin sont
  vérifiées sur `cerp_prod` et sur la nouvelle `cerp_test`.
