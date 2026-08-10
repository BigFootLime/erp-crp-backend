# Frontière des données de production backend

## Décision

Les jeux d’essai ne vivent plus sous `src/module`, car `tsc` compile ce répertoire dans `dist` même lorsqu’aucun module runtime ne les importe.

La fixture documentaire OF a été déplacée vers `test-support/production`. Les trois suites qui l’utilisent continuent de l’importer depuis cet espace hors build. Le contrôle `npm run security:production-data` refuse tout import runtime depuis un chemin `fixture`, `mock` ou `demo`. Le build réexécute le contrôle sur `dist` afin de prouver qu’aucun artefact de test n’a été émis.

## Données stock examinées pour ARIANE

`GET /stock/analytics` fournit :

- `ruptures_count` : rupture actuelle lorsque le stock géré a un minimum positif et une quantité disponible inférieure ou égale à zéro ;
- `at_risk_reservations_count` : réservations actives expirant sous sept jours ou insuffisamment couvertes.

Ces deux compteurs ne constituent pas une prévision de rupture à sept jours : ils n’intègrent pas ensemble la demande future, les approvisionnements attendus et leurs dates. Aucun nouveau contrat backend trompeur n’a donc été ajouté dans SOL-07.

## Données et migrations

Aucune migration et aucune écriture de données. Le déplacement concerne uniquement une fixture de tests versionnée.

## Rollback

Revenir au commit parent remet la fixture sous `src` et la rend à nouveau éligible à l’émission dans `dist`. Aucun rollback de base de données n’est requis.
