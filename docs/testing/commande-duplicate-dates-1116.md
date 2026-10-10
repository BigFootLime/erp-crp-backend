# Duplication de commande — dates civiles (#1116)

La duplication transforme les lignes PostgreSQL DATE en dates civiles ISO depuis un repository de lecture dédié. Aucune conversion par String(Date), aucun changement de jour lié au fuseau ou à DateStyle. Les valeurs nulles restent nulles. Les règles de contrat, article, dossier technique et PDF transactionnel restent dans le repository propriétaire. Zéro migration.

La suite PostgreSQL utilise uniquement une base locale jetable nommée cerp_commande_duplicate_dates_1116_test. Elle rejoue le défaut de type Date, puis vérifie le transfert vers des colonnes DATE, les jours de changement d’heure, null, plusieurs fuseaux et styles de date. Rejeu du bouton réel de duplication et livraison partielle requis après publication. Aucun email ni fixture Prod.
