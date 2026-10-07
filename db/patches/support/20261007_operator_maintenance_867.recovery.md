# Maintenance opérateur 867

Migration additive : cinq tables, deux colonnes et sept protections de l’historique. Aucune habilitation, tâche réalisée ou valeur de compteur ancienne n’est créée rétroactivement. Les programmes existants sans checklist/seuil doivent être configurés avant une nouvelle exécution.

Sauvegarder les deux bases et vérifier les dépôts documentaires avant publication. La migration réelle seule reste dans `db/patches` ; les précontrôles, vérification et récupération sont dans `db/patches/support`, hors du runner.

En cas d’échec de publication, conserver le schéma additif et revenir à la release précédente. Dès qu’une décision ou un relevé existe, corriger en avant : ne pas supprimer les tables, justificatifs ni historiques. Le rollback fourni s’arrête si des lignes existent et reste sous `ROLLBACK` pour inspection ; son exécution destructive et la cohérence du journal de migration nécessitent une intervention opérateur explicite.

Les preuves machine sont protégées dès leur utilisation ; la réponse applicative à un retrait est 409. Les arrêts sont persistants jusqu’à résolution avec justification et fichier réel. Résoudre un arrêt ne modifie pas le statut structurel de la machine ni les autres indisponibilités du planning.

Recette globale reportée à la fin du chantier sur instruction de Keenan. Compilation, préparation SQL sans données et disponibilité des services restent les préconditions de déploiement.
