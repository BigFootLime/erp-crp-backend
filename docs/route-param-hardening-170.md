# Durcissement des paramètres de route — issue #170

## Problème

Après la mise à jour de la branche d’intégration, les paramètres nommés
d’Express sont typés `string | string[]`. Onze appels des contrôleurs Gammes et
Versions transmettaient directement cette union à des services qui exigent une
chaîne, ce qui bloquait la compilation TypeScript.

Les validateurs de routes contrôlaient déjà les UUID à l’exécution, mais cette
garantie n’était pas reflétée dans les contrôleurs.

## Correction

Les contrôleurs Gammes et Versions utilisent désormais le helper partagé
`parseUuidRouteParam`. Les schémas Zod de leurs routes réutilisent la même
fabrique `uuidRouteParam` :

- seule une chaîne représentant un UUID valide est acceptée ;
- une valeur absente, multiple ou non UUID produit une erreur HTTP 400
  `INVALID_ROUTE_PARAM` ;
- les services continuent de recevoir exactement une chaîne ;
- aucune règle métier, route ou donnée n’est modifiée.

## Validation

- compilation TypeScript complète ;
- tests unitaires du helper (valide, absent, tableau, UUID invalide) ;
- tests routes/contrôleurs Gammes et Versions (400, 404, appels nominaux,
  création, mise à jour et réordonnancement).
