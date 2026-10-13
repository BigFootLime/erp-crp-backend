# Étiquettes de barres — #1248

Extension additive du suivi physique #1246 et du contrat d'identification SOL-30. Chaque barre reçoit un numéro lisible permanent ; le QR réutilise le format opaque `CERP:1:UUID`. Aucun solde ni réservation n'est changé par cette migration.

Avant application sur Test/Prod : sauvegarde VPS vérifiée, exécution ordonnée des dépendances, puis préflight et vérification. Qualifier sur base isolée la numérotation, la protection d'identité, création/réimpression, refus qualité et résolution vers le lot parent. Le test PostgreSQL d'identification utilise une ouverture synthétique de 6 000 mm en deux barres, sans prétendre valider la réception ni la découpe réelles.

En cas d'incident après utilisation, restaurer le code précédent en conservant le schéma additionnel : les numéros et preuves de scan restent conservés. Le rollback SQL refuse toute suppression s'il existe des barres ou des traces utilisant le nouveau type. Ne pas modifier les anciennes migrations déployées ni purger les journaux.
