# SOL-31 — Console d’exploitation CERP+ — rapport backend

- Date : 2026-08-15
- Issue : `BigFootLime/erp-crp-backend#517`
- Branche : `feature/517-sol31-operations-console`
- Base : `origin/dev` au démarrage
- Projet Office : aucun jeton/API locale disponible dans ce worktree ; issue
  GitHub créée avant modification, sans écriture dans une base de production.

## Diagnostic et cause racine

Les preuves existaient mais restaient réparties entre `collectReadiness`, les
métriques de processus, Prometheus, le registre SQL et plusieurs files métier.
Le navigateur ne disposait d’aucun contrat agrégé et aurait dû connaître la
topologie ou les jetons de supervision. L’historique des trois workers n’était
en outre pas uniformément publié dans les métriques communes.

## Choix d’architecture

- endpoint unique `GET /api/v1/admin/operations`, protégé par authentification
  et marqueur superadmin persistant ;
- lecture seule, réponse `private, no-store`, aucune action sensible ;
- réutilisation des sondes et seuils existants ;
- interrogation Prometheus uniquement depuis le serveur et seulement via une
  URL de configuration ;
- absence/péremption/échec explicites, jamais remplacés par un succès ou zéro ;
- faits exposés avec unité, période, source, fraîcheur et fiabilité ;
- compteurs de files uniquement, sans payload, PII ni contenu GED ;
- jobs webhook et facturation électronique rattachés aux métriques communes.

ADR : `docs/adr/ADR-0077-read-only-operations-console.md`.

## Fichiers modifiés

- module admin : contrôleur, repository, service et types de console ;
- route admin `/operations` ;
- métriques d’historique des dépendances et snapshot interne ;
- instrumentation des workers webhook et facturation électronique ;
- inventaire OpenAPI généré ;
- tests unitaires et RBAC ;
- ADR et présent rapport.

## Migrations et données

Aucune migration, aucun patch SQL, aucune donnée test ou production modifiée.
Le registre de migrations est lu sans écriture et comparé au manifeste livré
dans l’image.

## Tests exécutés

- `pnpm typecheck` : réussi en 13,7 s ;
- 2 fichiers ciblés Vitest, 7 tests : réussis ;
- `pnpm test:run` : 334 fichiers réussis, 2 ignorés ; 4 741 tests
  réussis, 5 ignorés, en 66,57 s ;
- `pnpm test:collection` : 336 fichiers vérifiés, manifeste SHA-256
  `c6369a18b43fa18d91e336d048bb75ea9989520c24cbedb1e6b52e40f93b535e` ;
- `pnpm build` : réussi en 16,4 s, 1 051 opérations OpenAPI inventoriées
  à 100 %, contrat construit valide et 724 fichiers émis conformes à la
  frontière de données de production ;
- `pnpm openapi:check` et `pnpm security:production-data` : réussis ;
- scénario Playwright SOL-31 sur la pile jetable SOL-05 : réussi en 21,0 s
  après 161 migrations isolées et un seed déterministe. Il couvre HTTP 200
  superadmin, HTTP 403 utilisateur standard et la restitution des signaux réels.

## Sécurité, risques et compatibilité

- un utilisateur anonyme reçoit 401 et un utilisateur non-superadmin 403 avant
  toute collecte ;
- les liens avec identifiants intégrés ou protocole dangereux sont rejetés ;
- le token Prometheus n’est jamais sérialisé ;
- le timeout Prometheus est borné à 1,5 s et une réponse supérieure à 1 Mo est
  rejetée ;
- sans configuration Prometheus, l’API métier reste disponible mais les
  sauvegardes sont correctement marquées `unavailable`.

## Rollback

Redéployer le SHA backend précédent. Aucune restauration SQL n’est requise.
Après rollback, valider `/health/live`, `/health/ready`, le login et un flux de
lecture. La pile Prometheus/Alertmanager reste indépendante.

## Reste réel

- Injecter sur chaque cible l’URL interne Prometheus et les liens Grafana réels ;
- ces valeurs ne peuvent pas être inventées ou committées car elles dépendent de
  la topologie opérateur et peuvent être sensibles.
