# Recette #1029 — affectation des réceptions libérées

Préparée, non exécutée ; à intégrer à la recette globale #1028–1035.

1. Réception réelle 120, commande 100 : 100 réservées pour la livraison, 20 sans réservation ; preuve métier DELIVERY 100 / FREE 20, aucun transfert physique déclaré.
2. Commande répartie en 20 urgentes et 80 au délai initial : aucune allocation ne dépasse son besoin ; l'AR initial et ses preuves OTD restent immuables.
3. Commande 100 : 30 expédiées, 20 réservées dont 10 préparées en BL ; réception 100 → réserver 50 supplémentaires, sans compter le BL préparé une seconde fois.
4. BL préparé sans réservation et ancien BL sans détail : la couverture indépendante est conservée, le dossier historique ambigu demande une revue avant nouvelle réservation.
5. Pièce à monter : réserve le composant attendu par le parent ; aucune réservation commerciale de la sous-pièce. Anticipation contractuelle sans appel ferme : aucun besoin client inventé.
6. Nouveau reçu en quarantaine, libération partielle 60 puis 20 puis rejeu : affectation totale 80 au maximum ; aucune seconde entrée en stock. Inclure un OF simple, un sous-OF, un montage et un producteur regroupé.
7. Deux utilisateurs réservent/reçoivent/libèrent le même lot : mêmes limites qualité et physiques, pas de dépassement des allocations ou de double attribution. Réception rejouée avec la même clé : même preuve et réponse compatible frontend.
8. Une réception 0,3 avec 0,1 expédiée et 0,1 réservée : seul 0,1 reste attribuable, sans arrondi flottant dans les écritures SQL.
9. Vérifier audit, événement de changement OF et preuves immuables ; essayer une mise à jour/suppression des attributions : refus SQL. Les scripts verify doivent renvoyer zéro anomalie.

La recette existante `production-workbench.integration.test.ts` couvre les anciennes libérations de regroupements ; les nouveaux fixtures de domaine sont `receipt-delivery-allocation.test.ts` et `receipt-lane-distribution.test.ts`. Les compléter par les scénarios PostgreSQL réels avant validation finale. La compilation n'est pas une recette métier.
