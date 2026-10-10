# Réapprovisionnement des contrats — lots fixes

Tâche Project Office : WP-286 / FLUX-20261009-05. Chantier parent : #1032.

Le calcul prend les manques mensuels nets issus de la couverture autoritaire existante. Il applique la taille de lot définie sur la ligne du contrat, avec arithmétique décimale exacte. Le surplus proposé couvre les mois suivants une seule fois ; il ne devient ni stock physique ni réservation. Les articles, indices, unités et sources Qualité/Planning restent ceux du calcul de couverture.

Cas vérifiés par les tests ciblés :

- manque 95, lot 40 : trois lots, quantité 120, surplus 25 ;
- manques 17 / 28 / 5, lot 20 : 1 / 2 / 0 lots, total 60 et surplus final 10 ;
- mois entièrement couverts, surplus conservé à travers un mois sans manque ;
- frontières décimales exactes, résultats déterministes et données sources inchangées ;
- lots de contrats distincts séparés, taille nulle/négative et chronologie invalide refusées ;
- cible historique du 30 septembre conservée avec retard au 10 octobre.

La réponse GET coverage expose `replenishment_projection` pour chaque ligne. OpenAPI décrit les quantités et le nombre entier de lots sous forme de chaînes, sans conversion flottante dans le moteur. L’endpoint reste en lecture seule et ne génère aucun OF. Il n’ajoute aucune migration.

La persistance des propositions, leurs états/idempotence, la génération via le moteur récursif canonique et la première date réalisable restent les étapes suivantes de #1032. Les appels CADRE historiques non rapprochés gardent leur refus explicite. La recette commune S04 ne sera complète qu’après ces étapes et leur rejeu réel.
