# Finitions — générateur FIN, #749

La création d’une finition retournait PostgreSQL 22023 : la fonction déployée autorisait MET mais avait perdu FIN. Une ancienne migration avait redéfini le même générateur. La migration finale rétablit la liste complète connue, sans toucher la séquence ni les données métier.

Avant application, sauvegarder le résultat `pg_get_functiondef` du préflight dans un fichier SQL. Appliquer la migration transactionnelle puis le verify. Celui-ci contrôle l’expression réellement déployée avec 16 exemples valides et invalides, sans appeler le générateur ni consommer de numéro. Refaire ensuite la création de la finition par interface sur cerp_test.

La fonction garde son identité et ses droits par CREATE OR REPLACE. L’application refuse une définition initiale inattendue. Aucun reset de séquence, aucune réaffectation de code.

Rollback : exécuter exclusivement la définition de fonction sauvegardée au préflight. Ne jamais ramener la valeur de séquence en arrière ; les numéros émis demeurent réservés.
