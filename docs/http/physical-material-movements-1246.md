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

## Compensation des mouvements généraux

L'aperçu de compensation vérifie les barres d'origine avant de proposer le
brouillon inverse. Lors de sa comptabilisation, ne pas envoyer `material_bars` :
l'ERP reprend les identités et longueurs depuis les événements immuables du
mouvement initial. Les vérifications sont répétées sous verrou.

- Annulation d'une sortie ou d'un ajustement négatif : restauration de la même
  barre, même si sa longueur restante était nulle ; réservations conservées.
- Annulation d'une entrée ou d'un ajustement positif : retrait des barres
  reçues encore inutilisées, avec conservation de leur identité et historique.
- Annulation d'un transfert : retour des mêmes barres à leur emplacement
  initial, avec les deux écritures canoniques et leurs preuves de déplacement.

Une utilisation, un déplacement ou un recomptage ultérieur impose de corriger
d'abord ces opérations. Une barre réservée ne peut pas être retirée ni déplacée.
La correction doit couvrir exactement la quantité d'origine, sans doublon.
L'API refuse un remplacement manuel des barres par 422
`MATERIAL_BAR_COMPENSATION_AUTOMATIC`, et un historique incompatible par 409
`MATERIAL_BAR_COMPENSATION_CHANGED`. Elle ne compense pas génériquement une
compensation antérieure. Réceptions métier et débits OF gardent leurs parcours
de correction propres ; aucun contournement par la compensation générale.

## Limites de livraison de cette branche

Les écrans doivent encore proposer ces commandes et préparer l'emplacement de
destination avant un transfert. Les sessions de comptage acceptent maintenant
leurs mesures physiques ; les écrans doivent les saisir et les présenter.
`SCRAP` et `DEPRECIATE` conservent
la quantité physique dans le ledger : ils ne sont pas acceptés comme `ISSUE`.
Leur affectation qualité par barre reste à raccorder. Les anciennes routes sont
protégées au commit mais ne constituent pas encore un parcours métier complet.
Recette sur schéma ERP complet et validation web/tablette restent nécessaires
avant fusion et déploiement. Ce document ne vaut pas validation métier.

## Comptage physique des barres

Le corps de saisie d'une ligne d'inventaire accepte `material_bars`, au format de
confirmation des barres : `expectedVersion`, `idempotencyKey`, `reason` et `bars`
(`id`, `lengthMm`, `allocations` avec `reservationId` et `quantityMm`). L'interface
réutilise les identifiants scannés et calcule `counted_qty` depuis les longueurs ;
le serveur vérifie leur égalité. Aucune longueur ou identité n'est déduite du
seul total. Une nouvelle barre nécessite une nouvelle identité.

La réponse de ligne expose `stock_batch_id`, `count_event_id` et `material_bars`
(relevé enregistré ou null). Un comptage matière suivi sans détail des barres
renvoie 422 `MATERIAL_BAR_COUNT_REQUIRED`. Le relevé est immuable ; toute nouvelle
mesure ajoute un événement. Enregistrer un relevé ne change ni stock ni barres.

La validation et la clôture contrôlent versions, longueurs initiales et totalité
des réservations OF. Un second comptage, s'il est configuré, est exigé aussi
lorsque la géométrie change sans écart de quantité. La clôture applique dans une
transaction unique l'ajustement canonique et le relevé des barres. Un écart nul
ne crée pas de mouvement fictif, mais conserve la preuve du recomptage. Une
mesure devenue périmée exige de reprendre le relevé avant validation.

Ordre de migration : barres, mouvements, comptages
(`20261012_physical_material_bar_counts_1246.sql`). Le rollback du comptage est
refusé dès qu'un relevé existe : son historique doit être conservé. Une correction
d'inventaire passe par un nouveau comptage, pas par une compensation générale
qui inventerait les barres à restituer.

## Qualité des barres

Après la migration `20261012_physical_material_bar_quality_1246.sql`, le stock
physique expose `batch.depreciatedMm` et `bars[].depreciatedMm`, en millimètres.
Le total des longueurs dépréciées doit correspondre au stock canonique. Elles
restent physiquement présentes, mais sont exclues des réservations et du débit.
Les statuts qualité du lot et les autres contrôles existants continuent à s'appliquer.

La comptabilisation d'un mouvement `SCRAP` ou `DEPRECIATE` accepte :

```json
{"material_bars":{"kind":"DEPRECIATE","expectedVersion":"<version chargée>","bars":[{"barId":"<barre sélectionnée>","expectedVersion":2,"quantityMm":1000}]}}
```

Le même champ accompagne une disposition `SCRAP` de non-conformité portant sur
de la matière déjà en stock. Un retour fournisseur utilise `kind: "ISSUE"` pour
les barres effectivement sorties. Le serveur refuse une sélection qui recoupe
des réservations OF ou une longueur déjà dépréciée ; la sélection est obligatoire
pour un stock dont les barres sont suivies. La décision avant entrée en stock
conserve son parcours Réception et n'accepte pas d'identités de barres inexistantes.

Le comptage accepte aussi `bars[].depreciatedMm` : il réaffecte la dépréciation
existante aux identités mesurées, sans pouvoir changer sa quantité totale. Un
changement d'affectation à total égal compte comme un changement du relevé.
L'inventaire historique est à rapprocher lorsqu'on connaît la quantité
dépréciée globale sans savoir quelles barres elle concerne.

Un transfert ordinaire ne peut pas emporter une barre dépréciée sans déplacer
ses soldes qualité ; ce cas nécessite encore le parcours qualité dédié. La
compensation générale des `SCRAP`/`DEPRECIATE` reste orientée vers Qualité.
Les écrans de sélection et le parcours complet réel restent à qualifier.
