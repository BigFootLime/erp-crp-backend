# Forfaits et frais de réception fournisseur — #1010

WP278. Le coût estimé de sous-traitance utilise une allocation cumulative du forfait, plafonnée à la quantité commandée. Le prix unitaire porte sur toute la quantité réelle reçue. Ordre déterministe des identifiants de ligne réception, sans prétendre à un FIFO physique. Précision Marges : six décimales. Transport non réparti et faits incomplets restent UNKNOWN avec explication ; aucune modification du flux physique, des anciennes versions ni du CUMP.

## Recette commune préparée — NON EXÉCUTÉE

1. Commande de 3 pièces, prix 1 €/pièce et forfait 10 €, trois réceptions d’une pièce : montants 4,333333 / 4,333334 / 4,333333 €, total 13 €. Le forfait total vaut exactement 10 €.
2. Même commande, une réception de 5 pièces : montant 15 €, forfait limité à 10 € ; prix sur les 5 pièces réelles.
3. Même commande, réceptions 2 + 2 + 1 : forfaits 6,666667 + 3,333333 + 0 €, total forfait 10 €. Vérifier la répartition dans l’ordre des identifiants réellement retourné.
4. Deux lignes/OF : chaque curseur est séparé ; aucun forfait ou transport de l’autre ligne inclus. Réception annulée et ligne annulée exclues avant le cumul.
5. Frais de port en-tête positifs/inconnus : coût de réception null, fiabilité UNKNOWN et explication de transport non réparti. La réception physique et les quantités restent disponibles.
6. Quantité commandée nulle/manquante, prix/remise/forfait invalides ou NaN/infini : coût inconnu explicite, aucun montant fabriqué ni erreur SQL de division.
7. Prix/forfait par défaut zéro : gratuité non justifiée. Prix zéro et forfait réellement positif : conserver le coût déclaré du forfait.
8. Facture partielle approuvée et rapprochée, transport commande non réparti : montant facturé vérifié conservé ; seul reliquat reçu non facturé reste inconnu et reprend son explication.
9. Facture pleinement rapprochée/approuvée/archivée, frais d’en-tête effectivement répartis : coût vérifié de facture remplace l’estimation inconnue, sans double comptage.
10. Facture non approuvée, unité/devise incohérente, réception annulée ou archives non contrôlées : conserver les garde-fous existants. Vérifier sur-facturation cumulée et avoir signé.
11. Nouvelle estimation/instantané Marges explique chaque source et reliquat. Les anciennes versions et captures Stock restent identiques ; pas d’approbation financière par l’agent.
12. Droits finance/Marges, Base test/Prod, absence de données en cache non autorisées et UI lisible : recette globale. Aucune commande métier réelle pendant les contrôles techniques.

Les deux fixtures ajoutées à `supplier-cost-reconciliation.test.ts` sont préparées NON EXÉCUTÉES. PREPARE/EXPLAIN sans ANALYZE valide les requêtes réelles sous `cerp_app` en ROLLBACK ; ce contrôle n’exécute pas cette recette numérique/métier. Preuves techniques et déploiement à consigner dans #1010.
