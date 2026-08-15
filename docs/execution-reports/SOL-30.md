# SOL-30 — Identification industrielle QR codes et codes-barres

Date d'exécution : 2026-08-14

Branche de travail : `feature/512-qr-barcode-flows`

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

Au moment de ce premier commit, l'application contrôlée sur `cerp_test` puis `cerp_prod` reste à exécuter après promotion du SHA sur `main`; elle sera ajoutée à ce rapport avec les identifiants de sauvegarde et les vérifications exactes.

## Tests et résultats

- `pnpm typecheck` : réussi.
- suite backend complète `pnpm test:run` : réussie avant la revue finale, durée 87 s.
- tests ciblés SOL-30 : 4 fichiers, 36 tests réussis en 10,39 s.
- `pnpm build` : réussi ; inventaire OpenAPI et frontière de données production validés.
- `npm audit --omit=dev --json` : 0 vulnérabilité de production.
- E2E Playwright isolé avec frontend et backend réels : 1 scénario réussi en 6,8 s, durée totale 85,4 s, 161 migrations appliquées.

## Vérification navigateur / E2E

Le scénario `industrial-identification-sol30.spec.ts` prouve : ouverture de la page protégée, résolution d'une étiquette réelle, passage hors ligne, persistance de l'intention, retour en ligne, synchronisation et état résolu. L'action métier reste volontairement à confirmer dans le module cible.

## Risques, compatibilité et rollback

- Les anciens modules ne sont pas réécrits : ils peuvent migrer progressivement vers le contrat SOL-30.
- Les lecteurs 1D utilisent Code 128 ; QR/Data Matrix exigent un lecteur 2D ou un navigateur avec `BarcodeDetector`. La saisie clavier reste toujours disponible.
- L'absence de connexion ne permet aucune validation métier. Cette restriction est intentionnelle.
- Rollback applicatif : redéployer le SHA précédent.
- Rollback DB : exécuter le script support seulement après sauvegarde et vérification qu'aucune étiquette SOL-30 ne doit être conservée ; la restauration de sauvegarde reste la procédure prioritaire en production.

## Reste réellement à faire

Promouvoir ce commit sur `dev` puis `main`, sauvegarder et migrer `cerp_test` puis `cerp_prod`, déployer Coolify et HYPERBOX2, et reporter ici les SHA, sauvegardes et preuves de santé. Aucun défaut fonctionnel ou test en échec n'est masqué à ce checkpoint.
