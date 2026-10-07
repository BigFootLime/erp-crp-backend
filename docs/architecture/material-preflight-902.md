# Contrôles matière en amont — WP-284 / #902

Le dossier technique complet valide la définition avant planning. Il ne garantit pas la disponibilité physique de la matière. Le regroupement et le premier démarrage continuent d’exiger toute la matière réservée et utilisable, avec deux origines au maximum, une pour une pièce critique.

Le GET existant `/production/ofs/:id/material` ajoute `physicalCoverage` : état, date du contrôle, besoins physiques manquants et blocages. Il réutilise `readMaterialReservationAvailabilityTx`, `missingPhysicalMaterial` et `assertMaterialOriginLimit`, également utilisés par les opérations et le regroupement. Une réservation en quarantaine ou devenue incompatible ne compte pas comme matière utilisable ; un achat attendu ne compte pas comme stock physique. La lecture est faite dans une transaction REPEATABLE READ READ ONLY et ne réserve, n’achète ni ne libère aucun lot.

Le champ est additif. Les réponses de mutation peuvent ne pas l’avoir ; l’interface relit alors la couverture. Les permissions et le masquage des prix restent ceux de l’API existante. Aucune migration pour ce premier lot.

## Suite obligatoire du chantier

- Conserver une demande d’achat liée au besoin OF avant choix fournisseur/prix. La confirmation actuelle ne le fait pas encore ; ne pas annoncer cette partie comme livrée.
- Étendre aux consommables avec distinction contenant global / besoin de production et rapprochement des approvisionnements existants.
- Réutiliser les propositions existantes seulement après adaptation à l’identité du besoin OF : les propositions actuelles par article/site réapprovisionnent des seuils de stock, ce qui ne suffit pas pour attribuer une couverture à un OF.
- Les bruts client restent un appel client, sans commande fournisseur automatique.
- Préparer les prestations avant l’étape précédente, tout en conservant l’interdiction de valider leur expédition physique prématurément.

## Vérification et recette

Compilation TypeScript/OpenAPI avant publication. Les requêtes de disponibilité réutilisées sont inchangées. La recette commune demandée par Keenan reste différée : réservation devenue bloquée, matière attendue non reçue, besoins non préparés, ancien indice, limites d’origine, concurrence entre OF et achat sans fournisseur. Aucun scénario métier n’est déclaré réussi par la seule compilation.
