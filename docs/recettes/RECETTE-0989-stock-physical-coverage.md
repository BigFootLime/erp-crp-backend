# Recette #989 — Stock physique et CUMP

**Préparée, NON EXÉCUTÉE.** À exécuter avec la recette commune finale sur Base Test.

- Projection PREPARED : aucun montant fiable, aucune activation implicite.
- Stock société avec niveau et lots : pas de double comptage ; réservations
  sans effet sur la quantité financière ; dépréciation déduite.
- Lots société et client : positions distinctes, casse du code client conservée,
  valeur client exclue de la valeur société.
- Entrée ou sortie en attente pour l'article : état PENDING, montant masqué.
  Mouvement en attente pour un autre article : pas de blocage de celui-ci.
- Quantité projetée différente du physique : MISMATCH, montant masqué.
- Preuve de journal/solde manquante, capture absente, source physique invalide,
  stock négatif ou précision excessive : UNKNOWN ; aucune valeur reconstruite.
- Source physique invalide : aucune quantité partielle présentée comme complète.
- Stock nul avec valeur nulle : valeur zéro, coût unitaire nul. Stock nul avec
  valeur non nulle : aucune valeur publiée.
- Lecture simultanée à une réception : quantité et projection issues du même
  instantané PostgreSQL, sans verrouiller les mouvements physiques.
- Utilisateur sans droit prix : valeur, coût, fiabilité et référence financiers
  masqués ; authentification et capacité Stock read toujours nécessaires.
- Article absent : 404 ; identifiant invalide : validation de paramètre ; réponse
  no-store et OpenAPI conforme.
- Plus de 10 000 observations ou 1 000 positions : indisponibilité explicite,
  aucune somme partielle. Temps de réponse à mesurer pendant la recette finale.
- Confirmer qu'aucune écriture stock, activation CUMP ou modification financière
  n'est déclenchée par la lecture.
