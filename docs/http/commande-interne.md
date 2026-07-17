# Commande interne : validation et lancement

Ce document décrit le contrat backend du flux cible de commande interne. Il complète la décision fonctionnelle portée par l'issue frontend `crp-systems-web#153` et l'issue backend `erp-crp-backend#85`.

## Objectif

Une commande dont `order_type = INTERNE` est le point d'entrée unique du besoin interne. Sa validation génère, dans une seule transaction :

1. exactement une affaire de livraison ;
2. les allocations de toutes les lignes ;
3. un OF racine par ligne et les OF enfants issus de la nomenclature ;
4. le passage du workflow à `ATTENTE_PLANNING` ;
5. les événements et l'audit associés.

Le flux ne génère ni AR client, ni facture, ni BL. Le BL reste un résultat ultérieur du processus logistique, après libération qualité.

## Endpoint

`POST /api/v1/commandes/:id/generate-affaires`

La route exige une session authentifiée. Pour une commande interne, le lancement est réservé à un rôle d'administration, de direction ou de responsabilité production/atelier.

Requête canonique :

```json
{
  "decision": null,
  "livraison_count": 1,
  "lines": []
}
```

Les choix de stock d'expédition et les découpages en plusieurs affaires restent disponibles pour les commandes client historiques, mais sont interdits pour les commandes internes.

## Préconditions internes

- la commande contient au moins une ligne ;
- chaque ligne référence une `piece_technique_id` applicable ;
- une seule destination interne est définie par `dest_stock_magasin_id` et `dest_stock_emplacement_id` ;
- la destination correspond à un emplacement de stock existant ;
- l'utilisateur possède un rôle autorisé ;
- aucune génération précédente incohérente n'est déjà liée à la commande.

L'absence de stock disponible ne réduit pas le besoin à fabriquer : la quantité complète demandée alimente les OF.

## Réponse

Exemple simplifié :

```json
{
  "affaire_ids": [7],
  "livraison_affaire_id": 7,
  "livraison_affaire_ids": [7],
  "generation_mode": "INTERNAL_ORDER",
  "idempotent_replay": false,
  "workflow_status": "ATTENTE_PLANNING",
  "of_ids": [9, 10],
  "root_of_ids": [9],
  "child_of_ids": [10],
  "ofs": [
    {
      "id": 9,
      "root_of_id": 9,
      "parent_of_id": null,
      "generation_level": 0,
      "commande_ligne_id": 1
    },
    {
      "id": 10,
      "root_of_id": 9,
      "parent_of_id": 9,
      "generation_level": 1,
      "commande_ligne_id": 1
    }
  ],
  "warnings": []
}
```

`ofs` expose la topologie utile au frontend sans obliger celui-ci à reconstruire la hiérarchie.

## Idempotence

Une nouvelle demande après génération ne crée ni affaire ni OF supplémentaire. La réponse contient les identifiants et la topologie existants avec `idempotent_replay = true`.

Une ancienne commande interne possédant plusieurs affaires de livraison peut être relue, mais renvoie l'avertissement `LEGACY_MULTIPLE_DELIVERY_AFFAIRS`. Cette tolérance ne permet pas de créer un nouveau découpage.

## Erreurs métier principales

| Statut | Code | Signification |
| --- | --- | --- |
| 403 | `INTERNAL_ORDER_LAUNCH_FORBIDDEN` | rôle insuffisant pour lancer la commande interne |
| 400 | `INTERNAL_ORDER_SINGLE_AFFAIRE_REQUIRED` | `livraison_count` différent de 1 |
| 400 | `INTERNAL_ORDER_STOCK_DECISION_FORBIDDEN` | décision ou surcharge de stock fournie |
| 400 | `INTERNAL_ORDER_LINE_REQUIRED` | aucune ligne à fabriquer |
| 400 | `PIECE_TECHNIQUE_REQUIRED` | pièce technique absente sur une ligne |
| 400 | `DEST_STOCK_LOCATION_REQUIRED` | destination interne absente ou invalide |
| 409 | `INTERNAL_ORDER_AFFAIRE_MAPPING_INVALID` | liaison historique d'affaire incompatible |

## Traçabilité

Le succès écrit notamment :

- l'événement `AFFAIRES_GENERATED` commun au flux existant ;
- l'événement `INTERNAL_ORDER_LAUNCHED` avec affaire, destination, OF racines/enfants et statut ;
- le changement de statut dans `commande_historique` ;
- les métadonnées `internal_order_flow` dans les checkpoints ;
- l'audit applicatif de génération.

## Compatibilité

Le comportement des commandes client (`FERME`, `OUVERTE`, etc.) est conservé : analyse de stock d'expédition, confirmation éventuelle et livraisons fractionnées continuent d'utiliser le contrat historique.

Cette évolution ne nécessite ni nouveau patch SQL ni migration de production.
