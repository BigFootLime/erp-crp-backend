# Reprise d'une commande déjà réservée

Commande de recette109, ligne205 :12 pièces déjà réservées dans LOT1310,20 physiques et8 encore libres. L'ancien aperçu cherchait12 pièces dans le seul stock libre et proposait4 pièces supplémentaires. Il présente maintenant sa couverture physique propre, sans créer ni augmenter une réservation et sans retirer de stock disponible à une autre ligne.

Le lecteur exige une couverture exacte de toutes les lignes et conserve OLD/NEW. Il vérifie l'article, le niveau physique, le lot libéré et, lorsqu'il existe, le lot de stock physique. Quantités insuffisantes/excessives, mauvais article, lot bloqué et compteurs incohérents ne valent jamais couverture complète. Les contrôles qualité et d'expédition restent dans leurs commandes propriétaires.

La reprise de lancement existante conserve ses contrôles et son audit. Pour la commandev2, elle relit les réservations verrouillées, réutilise les affaires, garde les OF annulés dans l'historique et passe vers l'AR seulement si ses conditions sont remplies. Aucun planning fictif n'est ajouté.

Validation :20 cas du lecteur, tests de reprise et de réservation existants, compilation stricte ; suite complète7641 tests/687 fichiers,254 tests/31 fichiers explicitement ignorés. Le mock d'audit qualité a été corrigé et le refus d'un audit absent est testé ; aucune protection de production n'a été supprimée. Le lecteur compilé réel a confirmé12 réservées et zéro fabrication dans une transaction READ ONLY sur cerp_test, sous cerp_app. Aucun changement de données.

Le premier essai SQL a révélé que le lot appartient à stock_batches et non à stock_levels. La jointure a été corrigée et rejouée sur le schéma réel. Déploiement, reprise UI vers AR/BL/facture et recette complète restent suivis séparément.
