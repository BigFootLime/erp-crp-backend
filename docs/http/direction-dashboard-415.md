# Cockpit Direction ARIANE — contrat HTTP SOL-16

- Route : `GET /api/v1/reporting/direction/overview`
- Contrat : `direction-dashboard/1.0`
- Authentification : session/JWT CERP+
- Autorisation : capacité backend `reporting_financial`
- Cache : `no-store, private`
- Fuseau : `Europe/Paris`

## Requête

Paramètres :

- `period` : `current_month`, `last_30_days`, `last_90_days`, `current_quarter`, `current_year` ou `custom` ;
- `from`, `to` : dates ISO requises par la politique de reporting pour `custom` ;
- `as_of` : date d'arrêté ISO, par défaut aujourd'hui à Paris ;
- `site_id` : UUID d'entrepôt ;
- `client_id` : identifiant client ;
- `currency` : devise ISO sur trois lettres ;
- `limit` : nombre de preuves/actions renvoyées, 1 à 50, défaut 20.

Une date impossible, une date d'arrêté antérieure au début de période ou un identifiant invalide renvoie 400. Un anonyme reçoit 401. Un utilisateur authentifié sans capacité financière reçoit 403.

## Réponse

La réponse contient :

- les filtres résolus et les options de filtre, avec indicateurs de troncature ;
- exactement quatre KPI (`otif`, `at_risk_orders`, `overdue_value`, `cash_30d`) ;
- une série OTIF de douze semaines ;
- les causes de retard classées ;
- une file d'actions ordonnée et des liens de drill-down ;
- l'état explicite `UNAVAILABLE` de la rupture prévisionnelle à sept jours ;
- les conventions et limites de calcul.

Chaque KPI fournit `value`, `unit`, `currency`, `status`, `reliability`, période, formule, sources, grain, fraîcheur live, couverture, entrées manquantes, ventilation par devise et preuves limitées. `null` signifie non calculable ; il ne doit jamais être converti en zéro par un consommateur.

## Règles de fiabilité

- `MEASURED` : calcul courant couvert par les sources autoritaires ;
- `PARTIAL` : calcul utile mais couverture ou historisation incomplète ;
- `UNAVAILABLE` : calcul non défendable.

L'OTIF et sa série historique restent `PARTIAL` lorsque des commandes sont éligibles, même avec 100 % de dates renseignées : les révisions successives de `commande_ligne.delai_client` ne sont pas historisées au grain ligne. Les lignes sans date sont exclues du dénominateur et comptées dans la couverture. Les retours ne réécrivent pas le verdict d'expédition initial.

Le filtre site s'appuie uniquement sur une destination, une réservation ou une allocation rattachée à l'entrepôt. Le cash filtré par site est `UNAVAILABLE` tant qu'une règle d'allocation financière au site n'est pas validée.

## Compatibilité

Les routes `/reporting/commercial/v2` ne changent pas de forme. Leur entrée de catalogue OTIF indique le contrat Direction, mais reste différée dans ce payload historique afin de ne pas annoncer un champ absent.
