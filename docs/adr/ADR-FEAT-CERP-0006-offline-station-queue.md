# ADR FEAT-CERP-0006 — File différée bornée du poste atelier

Statut : accepté pour le MVP. Le mode hors ligne n'est pas un second moteur métier.

## Décision

La station peut conserver localement, chiffrés par AES-GCM avec une clé non exportable, au plus quelques événements `POINTAGE_START`, `POINTAGE_STOP` et `QUANTITY_DECLARE`. Après retour réseau, l'opérateur se réauthentifie et envoie un lot de 1 à 25 événements à `POST /api/v1/production/station/offline/sync`.

Le serveur exige une session vivante au premier traitement. La session d'origine peut être close après réauthentification, mais elle doit prouver le même appareil, le même opérateur, la machine déclarée et une date d'événement comprise dans son cycle de vie. Chaque événement est borné à 24 h par défaut, tolère au plus 60 s d'avance d'horloge, possède un `event_id` et une clé d'idempotence. Un reçu déjà terminal est rejoué à l'identique sans réévaluer ces conditions volatiles. Une session d'exécution UUID stable, dérivée du `POINTAGE_START` et distincte de la session d'authentification station, relie le démarrage et ses dépendants.

Une réservation `PROCESSING` porte un bail de deux minutes et un jeton de fencing unique : un second appel reçoit `OFFLINE_EVENT_IN_PROGRESS` au lieu de concurrencer le premier. La transaction canonique verrouille et vérifie ce jeton avant tout effet, puis écrit l'effet, la réponse idempotente et le reçu `SYNCED` dans le même commit. Après expiration, la reprise obtient un nouveau jeton; l'ancien propriétaire ne peut donc produire aucun effet visible.

Un lot est volontairement partiel : chaque résultat terminal est `SYNCED` ou `REJECTED`. Un START absent ou encore `PROCESSING` libère immédiatement le bail du dépendant et produit un HTTP 503 rejouable; le reste du lot est néanmoins tenté, ce qui autorise un ordre d'arrivée intermittent. Une dépendance rejetée ou incohérente, un changement d'identité initial ou une collision produit un conflit terminal explicite; rien n'est écrasé. Aucun événement offline ne valide de qualité, ne réceptionne une production et ne crée de mouvement, lot, réservation ou décision de stock.

## Menaces et contrôles

| Menace | Contrôle |
|---|---|
| appareil perdu ou volé | aucune session/secret persistant dans la file; révocation du device et session vivante contrôlées à chaque sync |
| double clic, retry, double onglet | clé canonique et reçu serveur uniques; empreinte de requête immuable |
| substitution d'opérateur/station | identité appareil/opérateur exacte; session source et période d'origine vérifiées après réauthentification |
| horloge fausse | fenêtre passée/future bornée, dérive enregistrée, heure serveur retournée |
| réseau intermittent ou crash | dépendance absente rejouable; effet canonique et reçu dans une transaction unique |
| données altérées | conflit d'empreinte explicite; aucune mise à jour silencieuse |
| accumulation de données | purge des reçus terminés après 30 jours par défaut (7–365) |
| risque industriel | liste blanche de trois événements; aucune action stock/qualité irréversible |

## Exploitation et rollback

`STATION_OFFLINE_SYNC_ENABLED=false` coupe immédiatement le traitement au niveau processus. La ligne singleton `production_station_offline_config.enabled=false` fournit le kill switch base sans redéploiement; `cerp_app` ne peut pas la modifier. Un appel coupé retourne HTTP 503, `kill_switch_enabled: true` et aucun événement traité.

Les durées sont configurables par `STATION_OFFLINE_MAX_EVENT_AGE_SECONDS`, `STATION_OFFLINE_MAX_FUTURE_SKEW_SECONDS` et `STATION_OFFLINE_RECEIPT_RETENTION_DAYS`, toujours re-bornées par le serveur. Le rollback fourni est limité à `cerp_test` et refuse toute suppression si un reçu existe.

## Conséquences

Le client garde les statuts locaux `LOCAL`, `SYNCING`, `SYNCED`, `REJECTED`; seuls les deux derniers viennent du serveur. Le cache reste en lecture seule et explicitement daté. Le prototype est couvert par les tests de conflit, double synchronisation, crash avant accusé, dépendance et kill switch; son périmètre devient le contrat MVP, sans service worker ni background sync autonome.
