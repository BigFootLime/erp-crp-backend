# Recette commune — CUMP Stock #983

Statut : **PRÉPARÉE, NON EXÉCUTÉE**. L'utilisateur demande les tests métier réunis à la fin de l'objectif. N'activer aucune base réelle pour exécuter cette recette. Utiliser une base isolée avec fixtures nommées, après achèvement des adaptateurs et de la publication financière.

Scénarios purs : `src/module/stock/domain/cump-projection.test.ts` et `cump-valuation.test.ts`. Ils couvrent l'ouverture LEVEL/BATCH sans double compte, les réservations, la propriété client, les signes, les trois événements du transfert, les valeurs originales de retour, plafonds et reliquats, annulation au prix original et valeur négative inconnue.

| Cas transactionnel | Résultat attendu |
| --- | --- |
| PREPARED, même avec journal en attente | Zéro entrée/solde/curseur de frais ; capture physique normale |
| Deux workers concurrents | Un seul projecteur ; lot complet ou aucun changement |
| Transaction A garde une petite séquence non commitée, B commit une plus grande | La barrière attend ou abandonne sans avancer ; après commit A, aucune petite séquence perdue |
| Un transfert chevauche la limite de fenêtre | Lecture complète des trois preuves ; chaque événement neutre, quantité et valeur totales inchangées |
| Une jambe manque, propriétaire/unité diffère | UNRESOLVED sur l'article, pas de CUMP publié |
| Réception 3+3+3 avec forfait 1, puis réception excédentaire | Frais répartis exactement une fois ; total forfait 1, aucun forfait additionnel sur l'excédent |
| Première réception avant #980 ou source précédente illisible | Frais inconnus, aucun cumul mutable supposé |
| Modification réelle de quantité commandée/forfait/unité/devise | Curseur marqué incomplet ; pas de répartition réinterprétée |
| Simple variation de représentation 9.000000/9 ou pc/u | Même base ; aucune fausse modification de tarif |
| Retour partiel puis dernier retour | Montant original exact, somme des retours égale à l'original, rejet d'un dépassement financier |
| Inversion d'une réception après mélange de prix | Déduction de la valeur originale ; aucun prix moyen actuel appliqué à l'annulation |
| Erreur après écriture d'un premier propriétaire | Aucun solde/curseur/entrée partiel conservé |
| Commit accepté mais connexion coupée avant réponse | Passage suivant relit le curseur durable ; aucune duplication |
| Ouverture OLD sans valeur, réception sans prix ou devise étrangère sans preuve | UNKNOWN ; aucun prix catalogue, conversion ou zéro inventé |
| Source de précision impossible | UNRESOLVED isolée ; autres articles continuent ; aucune mutation physique |
| Écriture/modification/suppression directe, chaîne ou curseur falsifié | Guards SQL refusent ; preuves antérieures inchangées |
| Solde stocké avec nouveau mouvement non projeté ou écart physique | Publication financière supprimée jusqu'au rapprochement |

Les contrôles de livraison sont distincts : TypeScript/build/OpenAPI, DDL et PREPARE/EXPLAIN SQL en ROLLBACK, vérification de sauvegarde et santé/version/routage. Aucun cas du tableau n'est déclaré vert sur cette seule compilation.
