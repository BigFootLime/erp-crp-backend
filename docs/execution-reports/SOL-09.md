# SOL-09 — Logs structurés, supervision et alertes

- Date d'exécution : 2026-08-10
- Branche de travail : `fix/sol-09-observability`
- Base : `origin/dev` (`473c9d7` au démarrage)
- Environnement : worktree dédié, aucune connexion ni écriture de production
- Statut : implémenté et validé ; activation du destinataire privé requise au déploiement

## Diagnostic et cause racine

L'API disposait d'un request ID et de journaux ponctuels, mais sans schéma commun,
contexte asynchrone, règle centrale d'expurgation ni corrélation garantie avec le
navigateur. Le healthcheck Docker interrogeait une route de présence qui ne
représentait pas PostgreSQL, la GED, ClamAV ou le temps réel. Aucune métrique ne
rendait visibles la latence, les erreurs, le pool DB, le stockage ou les jobs.

La cause racine était une observabilité construite localement par fonctionnalité,
sans frontière transversale ni contrat opérateur.

## Choix d'architecture

- contexte `AsyncLocalStorage` par requête et validation stricte de
  `X-Request-Id` / `X-Correlation-Id` ;
- ligne JSON canonique avec timestamp, niveau, service, version, environnement,
  événement et identifiants de corrélation ;
- sanitizer central refusant PII, secrets, contenus, chemins GED, SQL, payloads,
  stack et tokens ; les erreurs gardent seulement type, code et empreinte ;
- noms de routes bornés et templatisés, références métier hachées ;
- `/health/live` limité au processus, `/health/ready` fondé sur des sondes réelles
  DB/GED/antivirus/realtime, avec source, fraîcheur, fiabilité et périmètre ;
- `/internal/metrics` au format Prometheus, fail-closed sans jeton et protégé par
  comparaison en temps constant ;
- métriques en mémoire à cardinalité bornée, sans SDK externe dans le processus.

La pile de collecte, les dashboards, alertes et runbooks sont versionnés dans le
dépôt frontend afin de conserver un seul plan de déploiement d'infrastructure.

## Fichiers modifiés

- `src/shared/observability/` : contexte, runtime, logger, métriques, santé et routes ;
- `src/middlewares/requestId.ts`, `requestLogger.ts`, `errorHandler.ts` : propagation,
  métriques et erreurs expurgées ;
- `src/config/app.ts`, `database.ts`, `src/index.ts` : montage, CORS, pool, cycle de vie ;
- `src/module/facturation/services/reminder-job.service.ts` : cycle du job critique ;
- `src/module/ged/services/ged-vault.service.ts` : sonde `statfs` et capacité ;
- `src/shared/uploads/upload-scanner.ts` : sonde antivirus live non bloquante ;
- `Dockerfile`, `.env_exemple` : readiness et variables documentées ;
- `package.json`, `pnpm-lock.yaml`, `package-lock.json` : retrait de `morgan` et
  `@types/morgan`, chaînes de lockfile remédiées ;
- tests d'observabilité et adaptations des contrats historiques.

## Migrations et données

Aucune migration, aucun seed et aucune modification de donnée. Les sondes DB sont
en lecture seule (`SELECT 1`). Aucun secret ni endpoint de production n'a été utilisé.

## Tests et preuves

| Vérification | Résultat réel |
|---|---|
| Tests ciblés DB + routes clients | 2 fichiers, 41/41 réussis |
| Tests ciblés observabilité + erreurs | 37/37 réussis |
| Suite backend complète, rapport JSON Vitest | 262 fichiers ; 4 404 réussis, 0 échec, 4 ignorés sur 4 408 |
| Répétition supplémentaire de la suite complète | code retour 0 |
| `pnpm run build` | réussi ; 624 fichiers runtime puis 624 fichiers émis contrôlés |
| `pnpm audit --prod --audit-level high` | aucune vulnérabilité connue |

Les messages `image_storage_unavailable` observés dans la suite CORS proviennent
du scénario négatif existant et n'ont pas fait échouer la suite.

## Vérification navigateur / E2E

Le test Playwright du dépôt frontend provoque une réponse de connexion 503,
vérifie les deux headers de corrélation, la référence affichée à l'écran, le log
navigateur JSON correspondant et l'absence du nom d'utilisateur/mot de passe.
Résultat final : 1/1 sous Chromium. Aucun changement visuel n'a été introduit.

## Risques et compatibilité

- En production, la readiness exige par défaut DB, GED, antivirus et realtime :
  un déploiement mal configuré restera volontairement non prêt.
- Les métriques sont locales au processus ; un redémarrage remet les compteurs à
  zéro, tandis que Prometheus conserve les séries déjà collectées.
- Les anciens `console.*` deviennent des événements expurgés en production. Ils
  restent natifs sous Vitest pour conserver les contrats de tests existants.
- Le retrait de `morgan` est compatible : le middleware structuré couvre chaque
  réponse et apporte route, statut, durée et corrélation.

## Rollback

Revenir au commit backend précédent, restaurer le healthcheck Docker historique
et retirer les variables `CERP_OBSERVABILITY_*` / `CERP_READINESS_*`. Aucune base
ni donnée ne doit être restaurée. Le rollback coupe métriques et corrélation mais
ne modifie aucun flux métier.

## Reste à faire réellement

Au déploiement seulement : injecter un jeton de scrape privé identique à celui de
Prometheus, déclarer les dépendances de readiness adaptées à l'environnement et
effectuer le test de notification vers le webhook privé de Keenan dans une
fenêtre planifiée. Ces valeurs ne doivent jamais être committées.
