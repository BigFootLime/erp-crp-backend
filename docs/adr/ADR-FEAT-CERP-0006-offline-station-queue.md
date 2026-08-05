# ADR FEAT-CERP-0006 — File différée bornée du poste atelier

Statut : accepté pour le MVP. Le mode hors ligne n'est pas un second moteur métier.

## Décision

La station peut conserver localement, chiffrés par AES-GCM avec une clé non exportable, au plus quelques événements `POINTAGE_START`, `POINTAGE_STOP` et `QUANTITY_DECLARE`. Après retour réseau, l'opérateur se réauthentifie et envoie un lot de 1 à 25 événements à `POST /api/v1/production/station/offline/sync`.

Le serveur vérifie à chaque reprise la session vivante, l'appareil, l'opérateur et la machine. Chaque événement est borné à 24 h par défaut, tolère au plus 60 s d'avance d'horloge, possède un `event_id` et une clé d'idempotence. Le moteur canonique de production applique chaque événement dans sa transaction existante. Le reçu de reprise peut rester `PROCESSING` après une panne entre l'effet et l'accusé : le retry rejoue alors la même clé canonique sans second effet.

Une réservation `PROCESSING` récente agit comme bail de deux minutes : un second appel reçoit `OFFLINE_EVENT_IN_PROGRESS` au lieu de concurrencer le premier. Après expiration, la reprise est autorisée et reste protégée par l'idempotence canonique.

Un lot est volontairement partiel : chaque résultat est `SYNCED` ou `REJECTED`. Une dépendance, un changement d'identité ou une collision produit un conflit explicite; rien n'est écrasé. Aucun événement offline ne valide de qualité, ne réceptionne une production et ne crée de mouvement, lot, réservation ou décision de stock.

## Menaces et contrôles

| Menace | Contrôle |
|---|---|
| appareil perdu ou volé | aucune session/secret persistant dans la file; révocation du device et session vivante contrôlées à chaque sync |
| double clic, retry, double onglet | clé canonique et reçu serveur uniques; empreinte de requête immuable |
| substitution d'opérateur/station | identité exacte comparée à la session réauthentifiée |
| horloge fausse | fenêtre passée/future bornée, dérive enregistrée, heure serveur retournée |
| réseau intermittent ou crash | reçu `PROCESSING`, action canonique transactionnelle, reprise idempotente |
| données altérées | conflit d'empreinte explicite; aucune mise à jour silencieuse |
| accumulation de données | purge des reçus terminés après 30 jours par défaut (7–365) |
| risque industriel | liste blanche de trois événements; aucune action stock/qualité irréversible |

## Exploitation et rollback

`STATION_OFFLINE_SYNC_ENABLED=false` coupe immédiatement le traitement au niveau processus. La ligne singleton `production_station_offline_config.enabled=false` fournit le kill switch base sans redéploiement; `cerp_app` ne peut pas la modifier. Un appel coupé retourne HTTP 503, `kill_switch_enabled: true` et aucun événement traité.

Les durées sont configurables par `STATION_OFFLINE_MAX_EVENT_AGE_SECONDS`, `STATION_OFFLINE_MAX_FUTURE_SKEW_SECONDS` et `STATION_OFFLINE_RECEIPT_RETENTION_DAYS`, toujours re-bornées par le serveur. Le rollback fourni est limité à `cerp_test` et refuse toute suppression si un reçu existe.

## Conséquences

Le client garde les statuts locaux `LOCAL`, `SYNCING`, `SYNCED`, `REJECTED`; seuls les deux derniers viennent du serveur. Le cache reste en lecture seule et explicitement daté. Le prototype est couvert par les tests de conflit, double synchronisation, crash avant accusé, dépendance et kill switch; son périmètre devient le contrat MVP, sans service worker ni background sync autonome.
