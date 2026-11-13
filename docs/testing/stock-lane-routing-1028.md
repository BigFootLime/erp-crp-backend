# Recette préparée — routage physique #1028 / #1029

Statut : **NOT RUN**, recette commune à la fin du chantier.

- Paramétrer trois destinations par les champs CERP ; vérifier les capacités, l'activité et le mapping. Une configuration partielle reste inactive. Un remplacement de destination invalide la version de l'ancien emplacement.
- Réceptionner 120 pièces libérées pour une affaire de 100 : 100 DELIVERY réservées, 20 FREE non réservées ; somme physique 120, aucune double entrée ni consommation qualité supplémentaire.
- Recevoir une sous-pièce de montage : quantité attendue ASSEMBLY avec exigence composant conservée, surplus FREE ; puis montage final selon commande ferme ou anticipation.
- Scinder 20 urgentes / 80 normales et recevoir plusieurs fractions : réservations par restant réel, AR conservé, aucun sur-réservé après préparation de BL.
- Réutiliser un batch comportant déjà consommations/préparations : déplacer uniquement le nouveau delta, préserver les identifiants historiques et la somme des réservations restantes.
- Libérer deux fractions de même quantité après quarantaine : deux routes distinctes ; rejouer chaque confirmation ne produit aucun mouvement supplémentaire.
- Réceptionner avec zéro destination configurée : preuve métier explicite, routage inactif. Désactiver une destination après activation : 409 métier, réception et transferts entièrement annulés.
- Injecter une erreur après la première jambe et après relocalisation d'une réservation : aucune écriture de réception, transfert, route ou affectation ne doit rester.
- Recevoir en même temps qu'une configuration et qu'un BL se prépare : versions cohérentes, réservation préparée protégée, aucune impasse de verrous.
- Vérifier quantité, article, unité, lot, source OLD/NEW, audit/outbox et disponibilité avec la preuve SQL et les écrans ; aucune donnée historique déplacée implicitement.

Les vérifications SQL de compilation et de migration ne constituent pas la recette métier.
