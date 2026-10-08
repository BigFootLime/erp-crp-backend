# Recette acquisition CUMP — #980

Statut : scénarios préparés, **non exécutés**, à réunir à la recette finale #977/Stock/Marges.

1. Réception partielle d’une commande confirmée : seule la quantité réellement entrée en stock est valorisable. Remise et conversion m/mm proviennent des faits figés, pas du catalogue actuel.
2. Modifier ensuite le tarif, la commande ou le catalogue : l’empreinte et les faits d’acquisition historiques restent identiques. Les mouvements antérieurs à la frontière #980 ne sont pas enrichis avec les prix actuels.
3. Stockage de pièces emballées : la somme des portions corrobore la réception ; elle ne double jamais le coût ni la quantité. Contrôler liens, article, unité, fournisseur et propriétaire.
4. Forfait d’une ligne sur trois livraisons puis sur-réception : allocation totale exacte et plafonnée, avec curseur Stock verrouillé. Sans curseur, le coût reste inconnu. Transport d’en-tête non alloué : inconnu.
5. Article de prestation différent de l’article stock, MP propriété client, devise étrangère sans preuve de change, prix nul par défaut et conversion incompatible : inconnu avec motif, sans blocage supplémentaire du stock physique.
6. Transaction interrompue/rejouée : pas de double preuve ni de preuve orpheline. Deux réceptions concurrentes : preuve complète dans chaque transaction, futur curseur de frais sérialisé.
7. Écriture ordinaire, modification, suppression et TRUNCATE de preuve : refusés. Les écrivains Stock légitimes, y compris leurs lignes insérées après l’en-tête, restent couverts à la fin de la transaction.

Scénarios numériques préparés : `src/module/stock/domain/receipt-acquisition-value.test.ts`. Compilation TypeScript et DDL/SQL dans ROLLBACK ne valent pas exécution de cette recette.
