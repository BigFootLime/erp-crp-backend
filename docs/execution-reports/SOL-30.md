# SOL-30 — Identification industrielle QR codes et codes-barres

Date d'exécution : 2026-08-14, clôture opérateur : 2026-08-15

Branche de travail : `feature/512-qr-barcode-flows` ; preuve de release : `docs/sol30-release-evidence`

Dépôt : backend CERP+

## Diagnostic et cause racine

Les modules métier savaient déjà identifier certaines entités, mais il n'existait pas de contrat commun versionné pour les étiquettes, leur cycle de vie, la résolution multi-flux et la preuve des scans. Les identifiants métier risquaient donc d'être encodés directement et chaque flux pouvait recréer sa propre logique.

Le parcours hors ligne exposait un second risque : une lecture différée ne doit jamais être confondue avec une écriture de stock, de qualité, de production ou d'expédition. SOL-30 introduit une frontière explicite entre **identifier/orienter** et **confirmer l'action métier**.

## Choix d'architecture

- Payload public minimal et versionné : `CERP:1:<UUID public>` ; aucun secret, numéro métier ou donnée personnelle n'est encodé.
- Résolution serveur centralisée pour article, lot, emplacement, OF, commande fournisseur, réception, contrôle qualité, outil et livraison.
- Contrôle cumulé du rôle et de l'accès au module cible ; une réponse interdite n'expose pas l'identifiant de l'entité.
- QR Code, Code 128 et Data Matrix générés côté serveur par `bwip-js@4.11.2` avec code humain lisible.
- Cycle de vie audité : émission, impression, réimpression motivée, invalidation et remplacement.
- Idempotence stricte par UUID pour les commandes et par `event_id` pour les scans ; un rejeu avec un contenu différent est refusé.
- Le serveur persiste uniquement le SHA-256 du payload scanné. Le contenu brut n'est ni journalisé ni conservé dans l'événement de scan.
- La synchronisation hors ligne ne résout qu'une intention. `requires_online_confirmation=true` et `writes_business_data=false` interdisent toute mutation métier implicite.

## Fichiers modifiés

- `src/module/identification/**` : domaine, validation, dépôt, service, contrôleur et routes.
- `src/routes/v1.routes.ts` : montage sous `/api/v1/traceability/identification`.
- `db/patches/20260814_identification_labels_sol30.sql` et scripts support preflight/verify/rollback.
- `scripts/db-patches.js` et tests du registre immuable.
- inventaire OpenAPI généré et documentation HTTP.
- `docs/adr/ADR-0076-versioned-industrial-identification-boundary.md`.
- `docs/runbooks/identification-labels-printers-sol30.md`.
- manifestes et lockfiles pour `bwip-js@4.11.2`.

## Migration et données

Le patch crée les tables d'étiquettes, impressions, scans, reçus d'idempotence et audits, ainsi que leurs contraintes et index. Il ne transforme aucune donnée métier existante et ne publie aucune étiquette automatiquement.

Répétition isolée réalisée : 161 patchs appliqués, 0 patch en attente, 0 checksum divergent ; rollback puis restauration et rejeu réussis. Les preuves générées sont conservées dans `docs/release/MIGRATION_REHEARSAL_SOL_06.{json,md}`.

Le patch SOL-30 a ensuite été appliqué sur `cerp_test`, puis sur `cerp_prod`, après preflight et sauvegarde chiffrée hors site :

- PostgreSQL contrôlé : `17.10` ; checksum du patch : `e9a2a116945105fbcce2a4ecc7246b3c9708a9d64920ed5f7a8ef94dc3740a7d`.
- `cerp_test` : sauvegarde `/var/backups/cerp/cerp_test_pre_sol30_20260815-004544.dump.enc`, 73 086 592 octets, SHA-256 `e4e0619fb3d1d0afff5f160fc88fff934b92b3272d069af720ea0263cb92557f`, catalogue `pg_restore` de 4 619 entrées.
- `cerp_prod` : sauvegarde `/var/backups/cerp/cerp_prod_pre_sol30_20260815-004544.dump.enc`, 49 613 600 octets, SHA-256 `0a55e2aebfa654de325cb80162a81b2510d64a609a24daf1ce7567a498728992`, catalogue de 4 597 entrées.
- Les clés sont séparées des sauvegardes, sous `/root/.cerp-migration-keys/`, avec accès root uniquement.
- Chaque base a appliqué exactement 1 patch SOL-30 ; vérification réussie, rejeu à 0 patch, 0 divergence de checksum et 0 donnée fonctionnelle créée automatiquement.
- La sauvegarde `cerp_prod` a été déchiffrée uniquement en `tmpfs`, restaurée dans PostgreSQL 17.10 isolé, contrôlée (441 tables publiques), migrée, vérifiée puis rollbackée avec succès. Le conteneur et le dump clair ont été supprimés.
- Le premier passage de l'opérateur a révélé un défaut du hook de nettoyage après une restauration déjà réussie ; le hook a été corrigé, l'environnement temporaire nettoyé puis la procédure complète rejouée avec code de sortie 0. Aucun effet sur les bases cibles.

## Tests et résultats

- `pnpm typecheck` : réussi.
- suite backend complète `pnpm test:run` : réussie avant la revue finale, durée 87 s.
- tests ciblés SOL-30 : 4 fichiers, 36 tests réussis en 10,39 s.
- `pnpm build` : réussi ; inventaire OpenAPI et frontière de données production validés.
- `npm audit --omit=dev --json` : 0 vulnérabilité de production.
- E2E Playwright isolé avec frontend et backend réels : 1 scénario réussi en 6,8 s, durée totale 85,4 s, 161 migrations appliquées.

## Vérification navigateur / E2E

Le scénario `industrial-identification-sol30.spec.ts` prouve : ouverture de la page protégée, résolution d'une étiquette réelle, passage hors ligne, persistance de l'intention, retour en ligne, synchronisation et état résolu. L'action métier reste volontairement à confirmer dans le module cible.

La route déployée `/traceabilite/identification` a aussi été ouverte dans Chrome le 2026-08-15 avec la session administrateur réelle : écran complet chargé, caméra explicitement indisponible sur ce navigateur, repli douchette/saisie présent, file locale vide et aucune erreur console. Le bandeau de cet hôte indique `cerp_test (test)` ; aucune écriture n'a donc été utilisée comme preuve de production.

## Promotion et déploiement

- Backend fonctionnel : `1a6eaaa4`, PR #513 vers `dev`, puis PR #514 vers `main`.
- SHA backend `main` déployé lors du contrôle : `3dd529a6607b5d91b6751cde1bfc99664f1b9733`.
- Coolify : déploiement `v137zbl4qkbbrhxas8k4xztj`, réussi en 7 min 48 s ; `/health/ready` retourne `ready=true`, la version complète, DB, GED, antivirus et realtime opérationnels.
- HYPERBOX2 : release immuable `/srv/cerp/releases/20260815-3dd529a6`, build réussi (1 050 opérations OpenAPI, 720 fichiers runtime), services test et production prêts sur les ports 8082 et 8080 avec la version complète.
- Contrôle négatif : l'endpoint public de capacités d'identification retourne `401` sans authentification sur Coolify, HYPERBOX2 test et HYPERBOX2 production.
- Rollback HYPERBOX2 : retirer uniquement les drop-ins SOL-30 `zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-sol30-3dd529a6.conf`, exécuter `systemctl daemon-reload`, puis redémarrer `cerp-api-test` et `cerp-api-prod`. Les anciens drop-ins et releases restent présents.

## Risques, compatibilité et rollback

- Les anciens modules ne sont pas réécrits : ils peuvent migrer progressivement vers le contrat SOL-30.
- Les lecteurs 1D utilisent Code 128 ; QR/Data Matrix exigent un lecteur 2D ou un navigateur avec `BarcodeDetector`. La saisie clavier reste toujours disponible.
- L'absence de connexion ne permet aucune validation métier. Cette restriction est intentionnelle.
- Rollback applicatif : redéployer le SHA précédent.
- Rollback DB : exécuter le script support seulement après sauvegarde et vérification qu'aucune étiquette SOL-30 ne doit être conservée ; la restauration de sauvegarde reste la procédure prioritaire en production.

## Reste réellement à faire

Aucun reliquat fonctionnel SOL-30 connu. La promotion, les deux migrations, la restauration isolée, Coolify et HYPERBOX2 sont démontrés. Ce commit documentaire est promu séparément ; son SHA peut déclencher un redéploiement sans changement runtime, dont la convergence est vérifiée avant clôture.
