# ADR-0077 — Frontière de la console d’exploitation en lecture seule

- Statut : accepté
- Date : 2026-08-15
- Décisionnaire : Keenan Martin
- Portée : SOL-31

## Contexte

CERP+ dispose déjà de sondes de readiness, de métriques Prometheus, de
heartbeats externes, d’alertes et de runbooks. Leur consultation restait
cependant dispersée entre l’API, Grafana et les fichiers de preuve. Recalculer
ces états dans le navigateur dupliquerait les seuils, exposerait la topologie et
risquerait de transmettre des jetons de supervision au frontend.

## Décision

L’API expose `GET /api/v1/admin/operations`, après authentification et contrôle
du marqueur superadministrateur persistant. La réponse est privée, `no-store`
et strictement en lecture seule.

L’agrégateur réutilise :

- les sondes `collectReadiness` pour PostgreSQL, GED, antivirus et temps réel ;
- le manifeste SQL de l’image et `cerp_schema_migrations` pour les patches en
  attente et les divergences d’empreinte ;
- des comptages SQL sans contenu métier pour les files de relance, webhook et
  facturation électronique ;
- les métriques de processus déjà utilisées par Prometheus pour les jobs ;
- l’API HTTP Prometheus, si elle est configurée, pour les heartbeats de
  sauvegarde/migration et les alertes actives.

Chaque signal porte état, source, période, unité, fraîcheur, latence, fiabilité,
dernier succès/échec, périmètre touché et runbook. Une source absente, périmée
ou inaccessible reste `unavailable`/`stale` ; elle n’est jamais transformée en
succès.

## Sécurité

- aucun paramètre utilisateur ne choisit une cible réseau ; l’URL Prometheus
  vient uniquement de la configuration opérateur ;
- les URL avec identifiants intégrés et les protocoles non HTTP(S) sont refusés ;
- le jeton Prometheus reste côté serveur et n’apparaît jamais dans la réponse ;
- aucun secret, PII, payload webhook, adresse destinataire ou contenu GED n’est
  lu ou retourné ;
- la console n’offre aucune mutation, réauthentification ou confirmation car
  SOL-31 n’expose volontairement aucune action sensible.

Une action de réparation future devra être une commande séparée, idempotente,
auditée, soumise à réauthentification et confirmation explicite. Elle ne pourra
pas être ajoutée à ce GET.

## Déploiement

Variables non secrètes :

- `CERP_OPERATIONS_PROMETHEUS_URL` : URL interne de Prometheus ;
- `CERP_OPERATIONS_DASHBOARD_URL` : lien opérateur Grafana ;
- `CERP_OPERATIONS_LOGS_URL` : lien opérateur vers les logs corrélés ;
- `CERP_RELEASE_COMMIT` : SHA exact si distinct de `CERP_RELEASE_VERSION` ;
- `CERP_PATCHES_DIR` : surcharge exceptionnelle du manifeste livré.

Variable secrète optionnelle : `CERP_OPERATIONS_PROMETHEUS_TOKEN`. Elle reste
dans le gestionnaire de secrets de la cible. Sans URL Prometheus, les sauvegardes
et leur historique sont honnêtement signalés comme non mesurés.

## Conséquences et rollback

Aucune migration ni donnée n’est créée. Le rollback consiste à redéployer le
SHA backend précédent puis le SHA frontend précédent. La suppression de l’URL
Prometheus ne bloque pas l’API métier : elle dégrade seulement les signaux
externes de la console. Les healthchecks de déploiement restent indépendants.
