# Recette commune #1032 — Couverture des besoins

Préparée, **NON EXÉCUTÉE** : les essais métier/UI sont réservés à la fin du chantier à la demande de Keenan. Cet incrément a uniquement ses vérifications de compilation TypeScript, lint, build/OpenAPI et préparation de huit requêtes SELECT sous le rôle applicatif dans les schémas Test/Prod, sans exécution des requêtes métier ni mutation.

| Situation | Résultat attendu |
| --- | --- |
| Estimation 100, convertie en ferme 30 | Demande nette 70 prévision + restant du ferme ; aucun double compte |
| Stock libre 50, N=30, N+1=40 | 30 affectables à N, 20 à N+1, manque cumulatif 20 |
| Deux contrats/clients partagent l’article | Budget stock partagé une fois, pas deux rapports additionnables |
| Affaire réservée à un autre client | Réserve dédiée, jamais utilisée par la demande consultée |
| Un lot sur deux emplacements, libéré partiellement | Budget qualité partagé une fois entre les positions |
| Qualité bloquée, OLD, article/indice différent, réserve inexpliquée | Exclusion, point de revue ou conflit métier explicite |
| Fermes partiellement livrés, parts urgentes modifiées | Restes et AR actuels exacts ; échéances historiques jamais réécrites |
| Livraison historique sans allocation / parts incohérentes | Refus de synthèse automatique ; pas de quantité inventée |
| Cadre ancien avec appels confirmés restants | Rapprochement requis ; quantité totale du cadre jamais comptée comme ferme |
| OF brouillon, non engagé ou opération dépassée | Exclu, même si la date de fin de fiche est dans le délai |
| OF producteur regroupé avec plusieurs sources | Producteur compté une fois, parts dédiées, surplus explicite libre |
| OF partiellement reçu / rebut déclaré | Seule la quantité restante sûre ; déjà reçu exclu |
| Pièces bonnes en attente de réception/libération | Exclues avec avertissement ; aucune disponibilité physique fictive |
| Montage sans composants libérés / matière manquante | OF exclu de la couverture engagée à temps |
| Cible précédente passée, données anciennes | Cible conservée et alerte ; besoins antérieurs inclus dans N |
| Limite de lots/OF/parts dépassée | Erreur métier de périmètre, aucun calcul partiel silencieux |
| Actualisation pendant une modification concurrente | Lecture cohérente ; prochaine génération doit recontrôler/verrouiller |

La matrice continue dans la recette de propositions : taille fixe, plusieurs lots, reprise idempotente, cumul des reliquats proposés, OF engagé tardif déjà lié, choix de rescheduling plutôt que doublon et conservation de la cible passée.
