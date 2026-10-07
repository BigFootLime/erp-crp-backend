# Poste Découpe — #883 / WP-281

Les routes `GET /production/station/cutting/:ofId/:operationId`, `POST …/scan` et `POST …/debits` utilisent la session atelier vivante. Le corps strict refuse une identité opérateur. Le contrôleur remplace l'acteur JWT par l'acteur de la session ; la commande matière vérifie appareil, session et opération, y compris avant un replay. Correction #889 : aucune machine sélectionnée dans la session n’est exigée. Un nouveau débit référence le pointage canonique actif de cet opérateur sur cet OF/OP, compatible avec la machine affectée à l’opération si elle existe. Une opération sans machine peut rester sans affectation ; les anciens pointages sans affectation d’OP restent utilisables.

Le serveur délègue aux propriétaires existants : identification pour l'étiquette active STOCK_LOT, matière pour réservations/stock/contrôles/rendements/idempotence, exécution pour la déclaration. Aucune table ni migration nouvelle. Les prix/catalogues/fournisseurs sont masqués sur cette surface. Le filtre `material_only` est appliqué avant la limite SQL de la file de travail.

L’adaptateur `POST …/execution` transmet démarrage, pause, reprise, arrêt et confirmation de fin au moteur canonique. L’acteur et l’audit viennent de la session tablette ; l’identité du compte JWT ne remplace pas celle du badge. Les hooks transactionnels revalident l’appareil, la session et le pointage nominatif avant effet et replay. L’affectation du démarrage vient de l’OF, jamais d’une machine arbitraire envoyée par l’écran. La fin accepte uniquement zéro nouvelle quantité : les bruts sont déjà déclarés par le débit matière. Réception/stock et compteurs restent propriétaires de leurs moteurs existants.

Recette commune à exécuter à la fin du chantier, selon instruction Keenan :

- Session fermée, expirée, tablette révoquée, machine changée entre lecture et commande : aucun nouveau débit.
- Opération différente dans le chemin/corps, sans besoin préparé, pointage incompatible avec la machine affectée à l’OP, ou pointage d'un autre opérateur : refus explicite.
- Session sans machine ou avec une ancienne sélection Atelier : les OF matière restent lisibles sans filtre ni alerte de machine choisie. Disponibilité de l’éventuelle machine de l’OF et couverture matière restent vérifiées au démarrage canonique.
- Étiquette inconnue/remplacée/autre type/lot non réservé : aucun mouvement ; la sélection manuelle d'une réservation reste possible.
- Même commande rejouée : même preuve et une seule sortie/déclaration ; même clé avec contenu différent : refus.
- Plusieurs débits de barres du même OF : origine/rendement distincts observés, limite globale 2 lots / 1 critique et couverture complète au démarrage conservées.
- Avant tournage : quantité potentielle ; solde au-delà de 150 mm après confirmation ; transfert conforme vers successeur validé ; fin avec zéro nouvelle quantité sans double déclaration.

Validation de publication : TypeScript et compilation PREPARE/EXPLAIN des sept requêtes réelles sous `cerp_app` sur Test dans une transaction annulée. Les cas Vitest sont préparés ; leur exécution et les scénarios métier sont différés à la recette commune.
