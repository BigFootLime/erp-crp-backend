# ADR #1029 — Attribution des réceptions de production libérées

Décisions métier : réunion du 9 octobre 2026 confirmée par Keenan, parent frontend #1252 ; stock physique et affectations, surplus libre, besoins de livraison et de montage distincts.

## Premier incrément

Les pistes physiques sont configurées par #1028. Cet incrément affecte les **réservations réelles**, sans déplacer les pièces : `physical_routing_applied=false`. L'activation des transferts et la reprise restent à terminer dans #1028–1029 ; aucune nouvelle disponibilité commerciale liée aux pistes n'est revendiquée.

La réservation commerciale couvre chaque allocation de livraison dans l'ordre de son AR actuel, limitée au restant commandé. Les quantités expédiées et les réservations actives sont comptées une fois. Une réservation déjà préparée en BL reste réservée ; seul un BL préparé sans réservation ajoute une couverture indépendante. Un ancien BL sans détail de lots exige une revue explicite. Une affaire expressément liée à un OF ne peut pas réserver les besoins d'une autre affaire.

Une réception nouvelle entre en quarantaine selon le contrôle existant. Après une libération Qualité réelle, les nouveaux reçus suivis par `production_receipt_lane_intents` déclenchent le même calcul pour OF simple, composants, montage, contrat interne et regroupement. Les anciennes réceptions restent hors reprise implicite ; le traitement existant des anciens regroupements est conservé.

Les affectations append-only comprennent la quantité concernée, les deltas exacts des réservations et la décision qualité. Un surplus sans réservation est attribué FREE ; une préproduction contractuelle sans appel ferme reste FREE. Les affectations FREE participent aussi au compteur déjà traité, afin qu'une nouvelle libération ne les attribue pas une seconde fois. L'opération reste dans la transaction Qualité/réception avec les compteurs physiques canoniques et les preuves d'audit.

Le contrat de réponse réception inclut les champs attendus par le frontend existant (`auto_reserved_qty`, `available_qty`, `message`). Le rejeu historique ajoute ces champs à la représentation, sans modifier le résultat enregistré. Une quantité en quarantaine n'est jamais présentée comme disponible.

## Conservation et déploiement

Le stock conserve son ledger unique, ses lots, OLD/NEW, indices, contrôles, réservations préparées et historiques de consommation. Aucun solde ni reçu ancien n'est réécrit par la migration additive. Un rollback conserve les preuves utilisées et restaure l'application précédente.

Contrôles techniques : compilation stricte, contrat OpenAPI, sources figées et migration préflight/verify avant déploiement. Recette métier/UI/concurrence globale **préparée, non exécutée**, conformément à la demande de la réaliser en fin de chantier. L'issue #1029 reste ouverte jusqu'à l'intégration des transferts physiques, des interfaces et de cette recette.
