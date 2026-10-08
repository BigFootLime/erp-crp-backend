# Recette #992 — Marges et coûts Stock

**Préparée, NON EXÉCUTÉE.** Exécution sur Base Test à la recette commune finale.

- PREPARED : prix appliqué déclaré maintenu, aucune fiabilité CUMP fabriquée.
- ACTIVE initialisé : une sortie matière/consommable/composant prouvée prend
  sa valeur historique, même si le prix de sa ligne ou du catalogue diffère.
- Sortie 10 / valeur 50, retour net 2 / valeur 10 : charge OF 40, quantité nette 8.
  Annulation du retour : charge 50 ; retour total : charge 0.
- Curseur inconnu, hors bornes, de mauvaise unité/devise/propriétaire ou sans
  dernier événement immuable valide : coût UNKNOWN, aucun calcul estimé.
- Montant de sortie modifié par rapport à l'arithmétique avant/après : UNKNOWN.
- Affectation OF/ligne/quantité non prouvée : UNKNOWN quand ACTIVE.
- Lot client : exclusion explicite du coût société, propriétaire figé conservé
  après modification éventuelle de la fiche lot actuelle.
- Retard de projection pour l'article ou preuve bloquée : coût UNKNOWN.
- Racine multi-lignes : aucune allocation devinée. Documenter les cas réels
  avant activation et prévoir une preuve d'affectation de chaque retour.
- Deux sorties partielles restent deux identités distinctes ; source manuelle
  en collision conserve les garde-fous existants ; aucun double comptage.
- Plus de 10 000 sources : indisponibilité explicite, aucun coût partiel.
- Accès sans droit prix/marges toujours refusé ou masqué selon politique actuelle.
- Réception simultanée : preuves et sources Stock lues dans un seul instantané.
- Vérifier l'arrondi du moteur Marge et mesurer le temps de lecture finale.
- Aucun effet de bord sur Stock, factures, déclarations, projecteur ou ouverture.
