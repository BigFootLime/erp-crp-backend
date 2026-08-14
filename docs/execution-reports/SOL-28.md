# SOL-28 — OpenAPI complète, versionnée et webhooks signés

- Date : 2026-08-14
- Propriétaire : Keenan Martin
- Issue de traçabilité : `BigFootLime/crp-systems-web#703`
- Branche : `feature/703-sol28-openapi-webhooks`
- Statut : implémentation et validation locale terminées ; promotion et recette déployée consignées dans la section finale après fusion.

## Diagnostic et cause racine

Le document historique `src/swagger/swagger.ts` ne décrivait que trois opérations Clients. L'inventaire construit depuis le graphe réel des routeurs Express en trouve 1 024 sous `/api/v1` : 1 016 authentifiées et 8 publiques. Aucun contrôle bloquant ne détectait une route nouvelle, une route publique sans justification ou un document OpenAPI périmé.

Les webhooks existants concernaient uniquement les callbacks entrants des prestataires de facturation électronique. Il n'existait pas de frontière sortante générique et durable pour les événements métier : ni registre versionné, ni signature, ni retry borné, ni dead-letter, ni rejeu idempotent audité.

## Choix d'architecture

- L'inventaire est généré par analyse AST du graphe des routeurs, mounts et middlewares Express réels. Le build échoue sur dérive, opération dupliquée, mount non résolu ou route publique sans politique explicite.
- Le contrat OpenAPI 3.0.3 conserve les schémas détaillés existants, fournit une couverture structurelle à toutes les routes et des contrats précis pour le nouveau domaine webhook. Un parseur OpenAPI valide le document pendant les tests et le build.
- `/api/v1/openapi.json` et `/docs` utilisent le même objet en mémoire. `info.version` vient de `CERP_RELEASE_VERSION` et le document expose le SHA-256 de l'inventaire des routes.
- Les webhooks projettent uniquement une liste blanche minimale depuis `erp_outbox_events`. Les payloads arbitraires, destinataires realtime, identifiants utilisateur et contenus documentaires ne sont jamais copiés.
- Les secrets aléatoires sont chiffrés en AES-256-GCM avec `CERP_WEBHOOK_SECRET_ENCRYPTION_KEY`, distincte des secrets JWT et PostgreSQL. Création et rotation ne retournent le secret que dans le résultat idempotent exact.
- Chaque livraison est signée HMAC-SHA256 sur `<timestamp>.<delivery-id>.<raw-body>`. L'adresse DNS publique contrôlée est épinglée dans la connexion HTTP/TLS afin de fermer le rebinding DNS ; les redirections ne sont pas suivies.
- La livraison est au-moins-une-fois, avec 8 tentatives bornées à 30, 60, 120, 240, 480, 960, 1 920 puis 3 600 secondes. Les erreurs terminales passent en dead-letter ; 401/403/404/410, cible privée ou secret illisible désactivent l'abonnement.
- Toutes les commandes d'administration exigent le marqueur `is_superadmin` relu en base et une clé d'idempotence UUID. Les mutations, rotations, tests, rejeux et désactivations automatiques sont audités.

## Fichiers modifiés

- Contrat : `scripts/openapi/`, `src/swagger/generated-route-inventory.ts`, `src/swagger/openapi-contract.ts`, `src/swagger/openapi.routes.ts`, `src/swagger/swagger.ts`, `src/routes/v1.routes.ts`, `package.json`, `pnpm-lock.yaml`.
- Webhooks : `src/module/integrations/webhooks/` et démarrage/arrêt du worker dans `src/index.ts`.
- Base : patch et scripts `preflight`, `verify`, `rollback` `20260814_api_contract_webhooks_sol28*`, registre du runner et répétition SOL-06.
- Tests : six fichiers SOL-28 et extension du test du registre des patches.
- Documentation : ADR-0074, guide d'intégration, collection Postman, rapport de couverture et preuve machine de répétition.

## Migration et changement de données

Le patch additif `20260814_api_contract_webhooks_sol28.sql` crée les tables d'abonnements, événements projetés, livraisons, tentatives, reçus idempotents, audit append-only et curseur d'ingestion. Aucune table métier existante n'est modifiée et aucune donnée de démonstration n'est chargée. Le curseur est initialisé sur la fin de l'outbox actuelle pour ne pas envoyer l'historique à de futurs abonnements.

Répétition Docker jetable PostgreSQL, stockage tmpfs, sans URL de production :

- sauvegarde avant migration : 1 968 426 octets, SHA-256 `4130172a6ac597173eb682161ced69a1c27aea823646a2289037a520133ef596` ;
- registre avant/après : 140 / 159 patches ; 19 patches appliqués dans l'ordre ;
- migration SOL-28 + vérification : 663 ms + 223 ms ;
- rejeu : 0 patch appliqué ;
- rollback : réussi en 444 ms, tous les objets SOL-28 retirés ;
- restauration vers une base neuve : réussie en 4 005 ms, empreinte identique à la source.

Preuve machine : `docs/release/sol28-rehearsal/MIGRATION_REHEARSAL_SOL_06.json`.

## Tests et résultats

- `pnpm typecheck` : réussi.
- `pnpm build` : réussi ; 1 024/1 024 opérations inventoriées, contrat OpenAPI valide, contrôle de frontière des 704 fichiers source puis émis réussi.
- suite backend complète : 1 016 suites réussies, 4 692 tests réussis, 0 échec, 5 tests explicitement ignorés, soit 4 697 tests collectés.
- tests SOL-28 : contrat OpenAPI, route publique, domaine/signature/chiffrement/IP, transport à adresse épinglée, retry/dead-letter, RBAC négatif, idempotence, migration et registre de patch couverts.
- `pnpm audit --prod --audit-level high` : aucune vulnérabilité connue.
- lint : aucun script de lint backend n'est défini dans ce dépôt ; le typecheck strict et le build bloquant ont été exécutés sans prétendre à un lint inexistant.

## Vérification HTTP et E2E

Il n'y a pas de changement d'interface utilisateur. La vérification HTTP Supertest prouve que `/api/v1/openapi.json` répond 200 avec `Cache-Control: no-store`, un ETag SHA-256 et la couverture attendue. Le test réseau ouvre un receveur HTTP jetable, force un nom non résolvable vers l'adresse déjà validée, contrôle le `Host`, le corps versionné, la signature et le statut durable. Les scénarios RBAC prouvent 401 anonyme, 403 utilisateur standard et 400 superadmin sans clé d'idempotence.

## Risques et compatibilité

- Aucun endpoint existant ni format métier existant n'est supprimé ; `/api/v1` reste la frontière stable.
- La couverture de routes est structurelle à 100 %. Les trois anciens contrats Clients et le nouveau domaine webhook ont des schémas détaillés ; les autres opérations déclarent honnêtement un schéma générique et leur source contrôleur/Zod au lieu d'inventer des champs.
- Le worker reste dégradé et n'émet rien sans clé AES valide. L'exploitation doit fournir la même clé séparée sur chaque instance backend avant d'activer la livraison.
- La garantie est au-moins-une-fois : le receveur doit vérifier la fenêtre de 300 secondes et persister chaque identifiant de livraison une seule fois.

## Rollback

Avant toute preuve webhook : arrêter le worker, vérifier la sauvegarde, exécuter le rollback fourni puis valider l'absence des objets. Dès qu'un abonnement, une livraison, un reçu ou un audit existe, le rollback SQL refuse volontairement la suppression. Le rollback opérationnel consiste alors à définir `CERP_WEBHOOK_DELIVERY_ENABLED=0`, redéployer la release précédente et conserver les tables pour rapprochement. Une restauration complète n'est utilisée qu'après décision d'incident et sauvegarde des preuves.

## Restant réellement à faire

- fusionner la branche vers `dev`, puis promouvoir `dev` vers `main` par PR ;
- sauvegarder, préflighter et appliquer le patch immuable sur la base test puis la base production autorisée ;
- provisionner sans affichage la clé AES séparée sur HYPERBOX2 et Coolify, déployer le SHA `main`, puis vérifier health, version, OpenAPI et contrôles d'accès ;
- compléter cette section avec les SHA, PR, sauvegardes et preuves déployées exactes.
