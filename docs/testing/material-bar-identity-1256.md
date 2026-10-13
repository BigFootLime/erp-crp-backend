# Identité scannée et transferts des barres — #1256

La vérification finale a détecté que l'identification 1248 remplaçait la fonction de transfert 1246 par une protection plus ancienne, interdisant tout déplacement. La migration corrective est additive : elle réunit le numéro public immuable et le déplacement d'une barre entière non réservée avec preuve immuable, deux écritures POSTED OUT/IN et égalité de la longueur transférée. Les migrations enregistrées et leurs checksums restent inchangés ; aucune géométrie ni donnée de stock n'est réécrite.

Les dépendances imposent le passage après identification et mouvements. Le rollback restaure la fonction antérieure sans supprimer les numéros ni les preuves. Les verify de l'identification, des mouvements et de la correction doivent tous passer après la dernière migration.

Le banc PostgreSQL isolé reprend la succession complète, le rollback de la correction, sa réapplication et les adapters existants de mouvements, débit, compensation, comptage et qualité. Il ajoute le refus d'une nouvelle valeur de numéro via UPDATE DEFAULT. Les transferts valides conservent l'identité scannée ; les réservations et les preuves insuffisantes restent bloquantes. Base de test et login temporaires sont retirés à la fin. Les tests du banc ne remplacent pas la recette ERP authentifiée ni les impressions physiques.

Le déploiement Test précédent a été arrêté par le verify et son service restauré automatiquement. Les backups VPS et HYPERBOX2 sont conservés. La connexion administrative HYPERBOX2 utilise maintenant son nom DNS avec la clé connue ; les migrations se font par le rôle propriétaire PostgreSQL local. Aucun élargissement des droits de l'application ni contournement de rôle n'est livré.
