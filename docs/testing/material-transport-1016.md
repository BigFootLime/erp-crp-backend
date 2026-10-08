# Recette commune — transport matière #1016

**NON EXÉCUTÉE** : l’utilisateur demande les tests métier réunis à la fin du chantier. Cinq fixtures préparées, aucun flux réel exécuté.

1. Une commande à deux unités différentes et transport positif : pondération par HT net, jamais par quantité ; total exact.
2. Remise et forfait de ligne inclus une seule fois ; les prix du catalogue ne s’ajoutent pas.
3. Trois réceptions partielles puis sur-réception : résidu exact et plafond transport/forfait de commande.
4. Ordre des lignes ou format décimal différent : même empreinte ; prix d’une autre ligne modifié : nouvelle empreinte.
5. Commande/fournisseur/devise/article/unité incohérents, ligne absente/dupliquée ou plus de 500 lignes : coût UNKNOWN expliqué.
6. Ancienne preuve avec transport positif sans base : UNKNOWN ; transport zéro connu conservé, transport null jamais assimilé à zéro.
7. Curseur positif puis transport supprimé, base changée ou historique non capturé : UNKNOWN, quantité comptée une fois.
8. Deux réceptions concurrentes : verrous projecteur et curseur sérialisés, aucun double coût ; reprise de transaction atomique.
9. Propriété client, service sous-traité avec autre article et conversion incohérente : aucune valeur inventée.
10. Réception/stock utilisables malgré un manque financier ; aucun verrou tardif sur commande ni opération physique artificielle.
11. Migration Test puis Prod une fois, status sans pending/checksum, rejeu sans patch ; rollback restaure ancienne capture sans supprimer de preuve.
12. Droits/appends/hash/portée des sources et journal Stock existants préservés ; projecteur toujours PREPARED, aucune activation.

Preuves techniques et de déploiement : à joindre après compilation/livraison. Les factures tardives et leur répartition stock/consommation restent à développer séparément.
