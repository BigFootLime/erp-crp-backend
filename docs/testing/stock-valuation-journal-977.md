# Recette finale — sources du journal CUMP #977

Scénarios préparés, non exécutés. CAPTURE_ONLY ne correspond pas à un CUMP actif.

- Noyau : `src/module/stock/domain/cump-valuation.test.ts`, prix pondérés, fractions/reliquat, prix absents, OLD, zéro explicite, négatif, unités/devises/propriétaires, transfert et retour original.
- Standard : DRAFT sans capture ; POSTED avec toutes les lignes et acteur réel ; erreur avant COMMIT sans mouvement ni journal ; rejeu idempotent sans doublon.
- Écrivains directs : ouverture historique, inventaire moderne et ancien, réception de fabrication, qualité, livraison/expédition et retour. Chaque effet POSTED a sa preuve dans le même COMMIT.
- Transfert : parent et deux jambes capturés avec liens exacts. La future projection les traite comme déplacement, sans doubler acquisition/consommation. Aucun coût n'est encore publié à cette étape.
- Inversion : preuve originale inchangée, inverse relié par reversal_of_id, acteur original conservé.
- Concurrence : insertion/édition/suppression/changement de parent d'une ligne face au posting. Après capture, elles échouent ; les lignes de l'écrivain POSTED passent dans sa propre transaction avant capture différée.
- Immutabilité : INSERT manuel, UPDATE, DELETE et TRUNCATE interdits. Rollback de posting sans journal. Diagnostic sans droit HTTP supplémentaire.
- Ouverture : niveaux/lots observés atomiquement, véritable code propriétaire client conservé, quantités réservées/dépréciées lisibles, aucune valeur historique inventée. Ne pas additionner LEVEL et BATCH.
- Source incomplète : unité, lignes ou rapprochement manquants conservés avec alerte ; aucun faux montant connu. Contrôles qualité/réservation inchangés sous leur propriétaire.
- Récupération : rollback vide, refus d'effacer les preuves réelles ; journal conservé lors du retour au backend précédent, ou sauvegarde complète vérifiée avant restauration.

La recette CUMP complète doit ensuite couvrir l'adaptateur, les valorisations, les corrections de facture et les projections stock/marges ; elle reste à compléter avec ces raccordements.
