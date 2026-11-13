# Recette #1028 — pistes de stock

Statut : préparée, non exécutée. À réunir avec la recette #1029–1035 en fin de chantier.

## Socle

1. Comparer chaque position projetée au niveau/batch canonique ; vérifier unicité, unités et scopes OLD/NEW. Ne pas additionner des unités différentes.
2. Configurer trois emplacements STORAGE vides, actifs, liés à leurs localisations et autorisant entrée/sortie. Vérifier droits lecture seule et `referential_manage`.
3. Refuser un mapping absent/inactif, une quarantaine, un rebut et une zone sans sortie. Deux utilisateurs partant de la même version : une seule modification réussit ; l'autre reçoit 409.
4. Rejouer exactement une confirmation : même version/résultat, un seul événement et audit. Réutiliser la clé avec un autre rôle : 409. Modifier/supprimer la preuve : refus SQL.
5. Refuser une reclassification occupée ; refuser la première classification FREE d'un emplacement contenant une réservation de livraison/montage. Aucun solde ni réservation n'est modifié par le paramétrage.
6. Afficher dans les paramètres et Magasins les rôles, emplacements, état réel, erreur/rechargement et positions paginées. Les contrôles sont ceux de CERP ; les aides sont en tooltip. Une quantité « sans réservation » n'est pas appelée « disponible qualité ».

## Reprise et raccordement

Après implémentation #1029 : réception 120, demande restante 100, livraison 100 et libre 20 ; montage et surplus ; OLD et dérogation d'indice ; transfert réservé à deux jambes atomiques, conservation du lot/qualité/consommations historiques ; contrôle qualité partiel ; réservation concurrente ; BL préparé puis annulé ; activation sans trois zones complètes refusée.

Critères de conservation : physique avant/après identique lors d'un transfert ; sortie/entrée corrélées égales ; somme des affectations égale à la quantité concernée ; aucune réservation préparée ou bloquée qualité libérée comme surplus.

La recette utilise la base Test et des données identifiées comme fixtures. Aucune validation métier n'est revendiquée à la seule compilation.
