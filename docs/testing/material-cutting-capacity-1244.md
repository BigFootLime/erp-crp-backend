# Capacité matière par source — #1244

Pour 20 bruts de 110 mm + 0,5 mm de coupe, les réservations 2000 mm et 210 mm de deux sources différentes couvrent 19 bruts, malgré leur total de 2210 mm. La disponibilité de lancement utilise désormais le nombre entier de bruts par stock_batch. Une nouvelle proposition prend 1989 + 221 mm ; une allocation déjà reçue reste tracée et peut recevoir un complément de 11 mm sur la seconde source.

Les réservations d'un même stock_batch et d'un même besoin sont des écritures comptables : elles partagent le rendement observé d'un débit, sans le compter deux fois. Le serveur détermine ce regroupement ; le client ne transmet pas de groupe libre. Les mouvements et quantités par réservation sont conservés. Les contrôles qualité, expirations, concurrence et limites d'origines restent applicables. Aucun patch SQL.

Validation locale du 12 octobre 2026 : 69 tests ciblés réussis (huit fichiers : material-cutting-capacity, of-material, material-reservation-availability, of-material-confirmation, of-material-debit, material-debit-balance, of-material-policy, of-material-receipts). Typecheck et build complet réussis. Le redémarrage et le rejeu métier Test ne sont pas encore réalisés pour ce correctif.

Limite explicite : stock_batch identifie un lot à un emplacement, pas nécessairement une barre individuelle. Le cas de plusieurs barres physiques d'un même lot requiert une qualification supplémentaire des longueurs et des chutes ; cette correction ne prétend pas prouver leur géométrie. Ne pas clôturer la recette globale ni promouvoir ce lot en production sur les seuls tests locaux.

Recette à rejouer : OF95/OF-2026-001238 sur cerp_test ; constater 19 au lieu du faux 20, compléter la seconde réservation de 11 mm sans achat supplémentaire, puis déclarer 18 + 2 bruts et vérifier le journal, le reliquat et la suite des opérations.
