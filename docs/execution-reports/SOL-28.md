# SOL-28 — OpenAPI complète, versionnée et webhooks signés

- Date : 2026-08-14
- Propriétaire : Keenan Martin
- Issue de traçabilité : `BigFootLime/crp-systems-web#703`
- Branche : `feature/703-sol28-openapi-webhooks`
- Statut : terminé, migré et déployé sur HYPERBOX2 et Coolify ; preuves de clôture ci-dessous.

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

## Promotion, migration et déploiement réels

### Git et reproductibilité

- implémentation : `815ca66033d2f632767ed603b601d40f5b1b3580` ;
- correctifs de portabilité OpenAPI : `4dca211`, `8776b2b` ;
- réconciliation stricte du patch GED historique : `60bf320` ;
- vérification de l'immutabilité avec un rôle propriétaire : `4e7b922` ;
- frontière Docker OpenAPI et lock npm : `b3199a0`, `fa334bf` et correctif de manifeste de couverture promu jusqu'au candidat `d37c2466fdab2aa0e6aa5e8c8e12326a974cda5a` ;
- PR d'implémentation et de promotion : `#487` à `#503`, toujours feature → `dev` puis `dev` → `main` ;
- à chaque promotion, les arbres `origin/dev` et `origin/main` ont été comparés identiques et les worktrees locaux officiels ont été avancés en fast-forward jusqu'aux refs distantes.

Le SHA du commit qui contient ce rapport est par nature auto-référentiel et ne peut pas être inscrit dans son propre contenu. La version finale se résout avec `git rev-parse origin/main` et doit être identique à `health.version` après la dernière promotion documentaire. Le dernier SHA fonctionnel mesuré avant cette clôture documentaire est `d37c2466fdab2aa0e6aa5e8c8e12326a974cda5a`.

### Base test

- sauvegarde chiffrée : `/var/backups/cerp/cerp_test_pre_sol28_20260814-202430.dump.enc`, 73 023 104 octets, SHA-256 `2f09614505f6d1dfa7e1c32ad0696cf922c1c07906f02014164b686160d16b64` ;
- clé séparée root-only : `/root/.cerp-migration-keys/sol28-20260814-202430-test.key`, mode `600` ;
- déchiffrement en tmpfs et `pg_restore --list` réussis, puis suppression du dump en clair ;
- preflight : PostgreSQL 17.10, 140 patches appliqués, aucune divergence de checksum, patch GED externe accepté uniquement avec son SHA exact et ses quatre preuves DB ;
- sélection immuable : uniquement `20260814_api_contract_webhooks_sol28.sql` ; application : 1 ; rejeu : 0 ; vérification SQL : réussie ;
- le test runtime de l'immutabilité insère une sonde, exige le rejet `SQLSTATE 55000`, puis annule la transaction. Les compteurs webhook restent tous à zéro.

### Base production

- sauvegarde chiffrée pré-migration : `/var/backups/cerp/cerp_prod_pre_sol28_20260814-204124.dump.enc`, 49 550 016 octets, SHA-256 `5588482899a0c910bbd2fbbec97f42ebb19344b8d9116b31e2b5c12feb92763b` ;
- clé séparée root-only : `/root/.cerp-migration-keys/sol28-20260814-204124-prod.key`, mode `600` ;
- validation réelle : déchiffrement en tmpfs et `pg_restore --list`, sans conservation de fichier en clair ;
- preflight : base `cerp_prod`, rôle `cerp_app`, PostgreSQL 17.10, 108 050 099 octets, 135 patches appliqués, 24 en attente, 0 checksum divergent et 0 patch inconnu ;
- la sélection `--only 20260814_api_contract_webhooks_sol28.sql` a appliqué exactement 1 patch sans appliquer les 23 autres patches en attente ; rejeu : 0 ;
- ledger post-migration : SHA `42d9f33de100499836e7c1d58ef49e91daffa4af3861c59536bc2d0ab0f87f1f` ; vérification : 7 relations présentes, 3 triggers append-only présents, sonde d'immutabilité rejetée et annulée, 0 donnée webhook ;
- restauration jetable `cerp_restore_verify_sol28_20260814_2042` : sauvegarde restaurée, absence pré-SOL-28 prouvée, migration puis rollback exécutés, absence post-rollback prouvée ; empreinte de comptage avant/après identique `1e0b47495556deb4bb90b4681f45f03039263e6fd04d6b7361fde218ab667b7c` ; base temporaire et fichiers tmpfs supprimés.

### Services et contrôles HTTP

- HYPERBOX2 test puis production : services actifs, readiness `200`, DB/GED/antivirus/temps réel `up`, environnement correct, contrat OpenAPI 3.0.3 de 1 024 opérations et accès anonyme à `/api/v1/admin/webhooks/subscriptions` refusé en `401` ;
- clés test et production séparées dans `/etc/cerp/webhook-secrets-*.env`, root-only `600`. La valeur production est partagée sans affichage avec l'instance Coolify qui utilise la même base ;
- Coolify : les échecs ont été reproduits puis attribués à trois entrées Docker absentes ou incohérentes : scripts OpenAPI non copiés, `package-lock.json` resté sur swagger-parser 10.0.3, puis manifeste de couverture non copié. Les trois défauts sont corrigés et couverts par test ;
- rolling update Coolify `cbcm75gxyh8pfn9vyxg9oj78` terminé le 14/08/2026 à 19:00:09 UTC. Le conteneur candidat `d37c2466fdab2aa0e6aa5e8c8e12326a974cda5a` a été déclaré sain avant retrait de l'ancien ;
- vérification interne et publique : liveness/readiness `200`, `health.version` et `info.version` égaux au SHA déployé, 1 024 opérations, extensions `x-cerp-route-coverage` et `x-cerp-contract-digest`, clé AES chargée (longueur contrôlée 64 sans affichage), worker activé et route admin anonyme `401` ;
- CORS connexion : preflight `OPTIONS /api/v1/auth/login` depuis `https://cerp.croix-rousse-precision.fr` → `204` avec `Access-Control-Allow-Origin` exact ; origine `https://attacker.invalid` → aucun header d'autorisation.

Le build Docker production installe 214 dépendances runtime avec 0 vulnérabilité connue. L'étage builder signale une alerte élevée limitée aux dépendances de développement ; le contrôle de production `pnpm audit --prod --audit-level high` reste à zéro et aucune dépendance de développement n'est copiée dans l'image runtime.

## Rollback opérateur vérifié

- application : remettre le drop-in systemd précédent ou redéployer l'image Coolify `679c691b6e4c116d7b927a40ae59a561210b8ce1`, puis vérifier liveness/readiness et version ;
- worker uniquement : `CERP_WEBHOOK_DELIVERY_ENABLED=0`, redémarrage contrôlé, conservation des tables et preuves ;
- base avant toute utilisation webhook : exécuter le script rollback fourni après sauvegarde ; son exécution a été prouvée sur la restauration réaliste ;
- dès qu'une preuve webhook existe, le rollback SQL refuse la suppression. La procédure correcte est alors de désactiver le worker et de conserver les données pour rapprochement ;
- dernier recours autorisé par décision d'incident : restaurer la sauvegarde chiffrée pré-SOL-28 avec sa clé séparée, puis exécuter les contrôles d'intégrité avant remise en service.

## Restant réellement à faire

Aucun développement, changement de données ou déploiement SOL-28 n'est en attente. La clôture doit seulement conserver l'invariant automatisé `git rev-parse origin/main == health.version` après le commit documentaire auto-référentiel ; cette vérification est effectuée dans la passation finale et ne change ni le schéma ni le comportement.
