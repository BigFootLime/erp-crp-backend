# Commande interne : fabrication, planning et mise en stock

Ce document décrit le contrat backend validé le 2026-08-26 pour `order_type = INTERNE` (`crp-systems-web#883`).

## Lancement

`POST /api/v1/commandes/:id/generate-affaires`

Requête canonique :

```json
{
  "decision": null,
  "livraison_count": 1,
  "lines": []
}
```

Le nom historique de l’endpoint reste compatible, mais une commande interne ne crée plus d’affaire :

- `affaire_ids`, `livraison_affaire_ids` : tableaux vides ;
- `livraison_affaire_id` : `null` ;
- aucune allocation de livraison ;
- aucune réservation de stock ;
- un OF racine par ligne et les OF enfants requis ;
- workflow placé sur `ATTENTE_PLANNING`, même lorsque les OF n’ont aucune opération.

Le rejeu est idempotent et retourne les OF existants. Une affaire interne historique est conservée en lecture et signalée par `LEGACY_INTERNAL_DELIVERY_AFFAIRE_IGNORED`.

## Préconditions

- au moins une ligne ;
- quantité positive ;
- pièce technique et version applicable sur chaque ligne ;
- rôle autorisé à lancer une commande interne ;
- `decision = null` et aucune surcharge de stock dans `lines`.

Le client commercial, le contact, la destination de livraison, une cadence, des documents qualité et une disponibilité stock ne sont pas des préconditions internes.

## Réception d’un OF interne

`POST /api/v1/production/of/:id/receipts`

Pour un OF issu d’une commande interne, `location_id` est facultatif et ignoré s’il est fourni. Dans la transaction, le backend :

1. lit le numéro client de la pièce technique ;
2. verrouille la destination logique ;
3. retrouve le magasin actif `NEW-PF` lié à un entrepôt ;
4. crée ou réutilise la location et l’emplacement dont le code est le numéro client ;
5. met le stock reçu à cette destination ;
6. ne crée aucune réservation de commande/livraison.

Erreurs principales :

| Statut | Code | Signification |
| --- | --- | --- |
| 403 | `INTERNAL_ORDER_LAUNCH_FORBIDDEN` | rôle insuffisant |
| 400 | `INTERNAL_ORDER_STOCK_DECISION_FORBIDDEN` | décision stock interdite |
| 400 | `INTERNAL_ORDER_LINE_REQUIRED` | aucune pièce à fabriquer |
| 400 | `PIECE_TECHNIQUE_REQUIRED` | pièce technique absente |
| 422 | `INTERNAL_ORDER_CLIENT_CODE_REQUIRED` | numéro client absent de la pièce |
| 503 | `NEW_PF_MAGASIN_REQUIRED` | magasin actif `NEW-PF` non configuré |
| 422 | `RECEIPT_LOCATION_REQUIRED` | emplacement absent pour un OF non interne |

## Compatibilité et réparation

- Les commandes `FERME` et `CADRE` conservent analyse OLD → NEW, réservation, AR et livraison.
- Une commande historique marquée `AR_PRET` par l’ancien contournement `no_plannable_operations` est replacée de façon auditée sur `ATTENTE_PLANNING` lors du rejeu, si l’AR n’a pas été envoyé.
- Aucune migration PostgreSQL n’est requise.
