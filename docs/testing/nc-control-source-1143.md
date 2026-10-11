# NC issue 1143 — provenance du contrôle

La déclaration depuis CQ1255 conservait control_id mais omettait son lot, sa réception et son fournisseur déjà connus. NC00002 sur Base Test demeure la preuve du défaut, sans réparation SQL métier.

La création résout désormais les liens du contrôle dans la transaction, avant les verrous existants livraison puis lot. Les liens connus sont repris ; un contrôle inexistant, une source LOT invalide ou une référence fournie contradictoire sont refusés avant insertion. Aucun client, OF ou identité non présent dans le contrôle n’est inventé. Les NC directes et contrôles historiques restent disponibles. Les writers d’audit, évènements, outbox et quarantaine sont inchangés. Aucun schéma ou migration.

Vérification ciblée : `CERP_NC_CONTEXT_PG_URL` doit désigner exactement la base jetable `nc_control_context_1143`, jamais `cerp_test`/Prod. Le test exécute la résolution réelle PostgreSQL sur les colonnes des patches qualité initiaux et 228 : source LOT/réception/fournisseur, conflit, absence, source invalide, OF historique, NC directe et conservation de saisie. Build strict et contrôles existants du module sont requis. Un test sauté n’est pas une validation PostgreSQL.

Le rejeu normal de création et la traçabilité stock après déploiement restent à documenter dans la recette WP285. Cette correction ne libère pas automatiquement les lots et ne constitue pas un PASS de la recette industrielle entière.
