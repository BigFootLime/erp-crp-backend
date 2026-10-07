# Préremplissage matière — WP-284 / #902

La projection matière ajoute une proposition de configuration et les références de nuance/état. Elle lit l’article matière et la nomenclature de la version applicable de la PT : snapshot figé prioritaire. Une opération est proposée seulement si son lien source, sa phase unique ou l’unique opération disponible permet de l’identifier.

Les caractéristiques enregistrées dans la préparation restent autoritaires, y compris les champs vides. Les propositions ne constituent ni validation des exigences, ni libération qualité, ni réservation. Le contrôle de version inclut les référentiels utilisés : le serveur refuse une confirmation devenue obsolète. La confirmation métier existante reste nécessaire.

Les unités de stock viennent de l’article. La longueur par brut et la longueur de la barre stockée sont distinctes. Une consommation n’est proposée que pour une conversion certaine : même unité, ou longueur connue de la PT convertie entre mm et m. Une unité ou une longueur inconnue reste à renseigner ; aucune désignation n’est interprétée comme une spécification technique. Une barre de 3 m n’est pas proposée pour tous les articles sans donnée source.

Les quatre lectures SQL ont été compilées dans une transaction de lecture seule par PREPARE et EXPLAIN sans ANALYZE sur Test, puis ROLLBACK. Aucun mouvement de stock, achat, qualité ou migration. La recette transversale reste différée conformément à la demande utilisateur et figure dans `docs/testing/upfront-prerequisites-1181.md` du frontend.
