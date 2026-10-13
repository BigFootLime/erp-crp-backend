# Annulation et éligibilité qualité (#1279)

Un contrôle vide annulé reste dans l’historique, mais ne constitue ni un contrôle en cours ni une décision. Le moteur d’éligibilité exclut désormais CANCELLED avant de choisir le dernier contrôle du lot. Une décision valide précédente reste bornée par sa quantité libérée et consommée ; les blocages de lot et non-conformités restent applicables.

Qualification :16 tests du moteur, build strict, puis15 contrôles PostgreSQL/HTTP sur une copie restaurée isolée. Après le parcours de libération normale des20 pièces, un nouveau recontrôle vide est annulé. L’éligibilité retrouve uniquement la décision précédente de20 unités ;21 unités restent refusées. Les contrôles historiques ne sont pas additionnés. Le contrôle concurrent, l’audit, l’immutabilité et les autres cas de #1276 restent testés dans ce même essai. La base isolée est supprimée ; Test/Prod restent inchangées par cet essai.

Le schéma minimal du test de concurrence contient maintenant le statut du contrôle. Aucun patch de base, permission ou nouveau mouvement de stock n’est ajouté par cette correction.
