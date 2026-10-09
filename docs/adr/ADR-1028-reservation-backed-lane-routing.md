# Répartition physique des nouvelles réceptions — #1028 / #1029

Décisions métier du 9 octobre 2026, parent frontend #1252. Suite du socle ADR-1028 et des affectations ADR-1029.

Une destination physique par piste est choisie explicitement dans les référentiels. Le routage devient actif uniquement lorsque FREE, DELIVERY et ASSEMBLY ont chacune un emplacement de stockage actif et compatible. Un emplacement configuré devenu indisponible bloque la réception avec une erreur métier ; il ne déclenche aucun transfert de remplacement silencieux. La configuration ne déplace ni ancienne réception, ni stock historique.

Après libération qualité, les deltas des réservations de la nouvelle réception déterminent DELIVERY et ASSEMBLY ; le surplus va en FREE. Stock poste les transferts par son service canonique, avec les deux jambes physiques existantes, dans la transaction de réception ou de libération qualité. Il ne crée pas une seconde entrée de fabrication. Lot, origine OLD/NEW, liens de commande et affaire ou de composant sont conservés.

Une réservation accompagne seulement sa quantité non préparée et non consommée. Son déplacement conserve les consommations antérieures et crée ou complète la réservation canonique de destination. Une réservation entièrement déplacée est libérée avec sa preuve positive historique ; une réservation partielle reste à son emplacement avec ses quantités consommées ou préparées. Les soldes physiques réservés suivent le transfert dans la même transaction. Toute erreur annule l'ensemble. Le registre existant génère les événements immuables des réservations.

Le verrou partagé de topologie précède les accès stock des réceptions et des libérations qualité ; la configuration utilise son pendant exclusif. Une version modifiée sur l'emplacement ou sa désignation comme destination provoque un rechargement explicite. Chaque fraction de libération possède ses propres clés de transfert, même si deux fractions ont la même quantité. Le rejeu de la réception restitue sa preuve originale sans créer de mouvements supplémentaires.

L'affectation immuable et le registre des routes physiques conservent source, destination, quantité, mouvements et identifiants de réservation avant/après. Les résultats historiques restent lisibles avec `physical_routing_applied=false` ; les nouvelles routes retournent les emplacements et identifiants réellement créés.

## Validation et périmètre restant

Compilation stricte et contrat OpenAPI avant publication. Preflight, sauvegarde, migration additive, compilation SQL, verify et santé des services à chaque déploiement. Recette métier, autorisations, simultanéité et UI **préparée, non exécutée**, à réaliser en fin de chantier conformément à l'instruction utilisateur.

La reprise des anciennes pièces, les annulations de réservations avec retour en FREE, les allocations depuis FREE aux nouvelles commandes et le prélèvement d'urgence demeurent des flux explicites à raccorder aux lots suivants. Ne pas déclarer #1028 ou #1029 terminées tant que leur recette et ces frontières ne sont pas validées.
