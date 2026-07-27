# Durcissement des paramètres de route — issue #170

## Problème

Après la mise à jour de la branche d’intégration, les paramètres nommés
d’Express sont typés `string | string[]`. Onze appels des contrôleurs Gammes et
Versions transmettaient directement cette union à des services qui exigent une
chaîne, ce qui bloquait la compilation TypeScript.

Les validateurs de routes contrôlaient déjà les UUID à l’exécution, mais cette
garantie n’était pas reflétée dans les contrôleurs.

## Correction

Chaque contrôleur extrait désormais le paramètre nommé avec une vérification
défensive :

- seule une chaîne non vide est acceptée ;
- une valeur absente, vide ou multiple produit une erreur HTTP 400
  `INVALID_ROUTE_PARAM` ;
- les services continuent de recevoir exactement une chaîne ;
- aucune règle métier, route ou donnée n’est modifiée.

## Validation

- compilation TypeScript complète ;
- tests `gammes.test.ts` ;
- tests `pieces-techniques-versions.test.ts`.
