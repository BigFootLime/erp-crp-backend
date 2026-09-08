# Récupération — dossier Complet et matière

Migrations additives, activées d'abord sur cerp_test. Avant application : sauvegarde PostgreSQL custom, contrôle par pg_restore -l et empreinte, préflight. Appliquer chaque fichier avec ON_ERROR_STOP puis sa vérification sous le rôle cerp_app et enregistrer son empreinte UTF-8 dans cerp_schema_migrations.

Le repli conserve les tables, les décisions, les réservations et les achats : désactiver PRODUCTION_MATERIAL_WORKFLOW pour fermer les nouvelles commandes et revenir au binaire précédent uniquement si aucune nouvelle allocation n'a été créée. Après création d'allocations, conserver le binaire avec les contrôles communs, même si les vues sont désactivées. Le retour intégral à une sauvegarde ferait perdre les écritures postérieures : il exige une décision explicite et une réconciliation préalable des nouvelles écritures.

Ne jamais supprimer les tables pour revenir en arrière. Les engagements créés doivent être libérés ou annulés par les actions métier tracées ; aucun achat envoyé ou lot consommé n'est effacé. Une simulation ou un retrait du planning ne supprime aucun achat.

Sauvegarde initiale de cette intervention : /var/backups/cerp/ux-material-20260907/cerp_test.before.dump et cerp_prod.before.dump, vérifiées le 7 septembre. Les nouvelles sauvegardes de déploiement doivent utiliser un nom distinct.
