# Mouvements de barres physiques — #1246

`POST /api/v1/stock/movements/:id/post` conserve ses habilitations et sa clé
`Idempotency-Key`. Pour un article matière en millimètres déclaré « barre à
découper », ou un lot de stock dont les barres sont déjà suivies, le corps doit
contenir `material_bars`. La version d'inventaire vient de l'API des barres ;
elle est opaque et doit être relue après toute modification.

Trois commandes strictes sont acceptées :

- `RECEIVE` : `expectedVersion`, `bars: [{lengthMm, count}]`. Entrée ou
  ajustement positif ; le total doit égaler exactement la quantité du mouvement.
- `ISSUE` : `expectedVersion`, `bars: [{barId, expectedVersion, quantityMm}]`.
  Sortie physique ou ajustement négatif ; seule la longueur libre peut être sortie.
- `TRANSFER` : `expectedVersion`, `expectedDestinationVersion`,
  `bars: [{barId, expectedVersion}]`. Barres entières, non réservées, même article
  et même lot. L'identifiant scanné et la longueur initiale sont conservés.

Exemple d'entrée confirmée de deux barres de 3 m, sur un mouvement de 6 000 mm :

```json
{
  "material_bars": {
    "kind": "RECEIVE",
    "expectedVersion": "<version renvoyée par l'inventaire>",
    "bars": [{"lengthMm": 3000, "count": 2}]
  }
}
```

Les nombres sont des nombres JSON, avec trois décimales maximum pour les
longueurs ; les nombres de barres et versions sont des entiers positifs. Les
champs inconnus, doublons d'identifiant, valeurs vides et chaînes numériques
sont refusés. Le client formate la saisie française avant envoi. Une longueur
d'achat suggérée n'est jamais considérée comme une mesure confirmée.

Les parcours serveur de réception, débit réservé et correction du débit
utilisent une autorisation interne liée à leur transaction et à leur mouvement
précis. Cette autorisation ne peut pas être fournie en JSON. Ils terminent leurs
mises à jour de géométrie et d'affectations avant le commit. Passer un client SQL
externe ne dispense pas de préparer les barres.

Les contrôles qualité, les droits stock, l'idempotence et les dérogations restent
en vigueur. Une dérogation de stock négatif n'invente pas une longueur physique.
L'incohérence finale provoque l'annulation de la transaction et une réponse 409
`MATERIAL_BAR_STOCK_INCOMPLETE`, sans détail SQL. Une sélection absente renvoie
422 `MATERIAL_BAR_MOVEMENT_REQUIRED` ; un instantané périmé renvoie 409
`MATERIAL_BAR_MOVEMENT_CHANGED`.

## Limites de livraison de cette branche

Les écrans doivent encore proposer ces commandes et préparer l'emplacement de
destination avant un transfert. Les compensations génériques d'une sortie et
les sessions de comptage doivent être raccordées à leurs preuves et mesures
physiques, au lieu de produire un simple total. `SCRAP` et `DEPRECIATE` conservent
la quantité physique dans le ledger : ils ne sont pas acceptés comme `ISSUE`.
Leur affectation qualité par barre reste à raccorder. Les anciennes routes sont
protégées au commit mais ne constituent pas encore un parcours métier complet.
Recette sur schéma ERP complet et validation web/tablette restent nécessaires
avant fusion et déploiement. Ce document ne vaut pas validation métier.
