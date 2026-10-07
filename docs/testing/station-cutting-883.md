# Poste Découpe — #883 / WP-281

Les routes `GET /production/station/cutting/:ofId/:operationId`, `POST …/scan` et `POST …/debits` utilisent la session atelier vivante. Le corps strict refuse une identité opérateur. Le contrôleur remplace l'acteur JWT par l'acteur de la session ; la commande matière vérifie appareil, session, machine et opération, y compris avant un replay. Un nouveau débit référence le pointage canonique actif de cet opérateur sur cette opération/machine.

Le serveur délègue aux propriétaires existants : identification pour l'étiquette active STOCK_LOT, matière pour réservations/stock/contrôles/rendements/idempotence, exécution pour la déclaration. Aucune table ni migration nouvelle. Les prix/catalogues/fournisseurs sont masqués sur cette surface. Le filtre `material_only` est appliqué avant la limite SQL de la file de travail.

Recette commune à exécuter à la fin du chantier, selon instruction Keenan :

- Session fermée, expirée, tablette révoquée, machine changée entre lecture et commande : aucun nouveau débit.
- Opération différente dans le chemin/corps, sans besoin préparé, autre machine, ou pointage d'un autre opérateur : refus explicite.
- Étiquette inconnue/remplacée/autre type/lot non réservé : aucun mouvement ; la sélection manuelle d'une réservation reste possible.
- Même commande rejouée : même preuve et une seule sortie/déclaration ; même clé avec contenu différent : refus.
- Plusieurs débits de barres du même OF : origine/rendement distincts observés, limite globale 2 lots / 1 critique et couverture complète au démarrage conservées.
- Avant tournage : quantité potentielle ; solde au-delà de 150 mm après confirmation ; transfert conforme vers successeur validé ; fin avec zéro nouvelle quantité sans double déclaration.

Validation de publication : TypeScript et compilation PREPARE/EXPLAIN des cinq requêtes réelles sous `cerp_app` sur Test dans une transaction annulée. Les cas Vitest sont préparés ; leur exécution et les scénarios métier sont différés à la recette commune.
