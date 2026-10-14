# Autocontrôle papier ou tablette — #1328 / WP-285

La clarification humaine autorise deux supports. En papier, le scan de la fiche renseignée et signée est obligatoire ; la ressaisie des mesures est facultative. En numérique, les mesures restent saisies au contrôle. Les deux parcours gardent une décision qualité explicite et les droits existants.

## Comportement livré dans la source

La commande `autocontrol-capture` est réservée aux contrôles `OF_OPERATION` de première pièce, en cours de fabrication ou finaux. Le contrôle doit appartenir à l’OF et à l’opération de la session. Le fichier PDF/JPG/PNG doit être enregistré dans les documents de ce contrôle, présent sous la racine qualité, intact et vérifié par l’antivirus. Le serveur conserve la preuve, le résultat confirmé, les instruments réellement employés et l’acteur. Aucune mesure n’est inventée ; aucune libération ou entrée en stock ne découle du dépôt.

Le résultat papier confirme la quantité conforme dans la population du contrôle. La fiche complète remplace les valeurs numériques, pas l’identification des instruments exigés : leur éligibilité et leur preuve restent vérifiées par Métrologie. Un résultat partiel ou non conforme conserve les règles de disposition. L’aperçu est recalculé à partir de la preuve papier, puis la décision distincte utilise le même moteur de quantités que le numérique.

Les commandes sont versionnées, idempotentes et auditées. Une exécution contenant déjà des mesures ne peut pas passer en papier. Un passage papier → tablette avant décision retire l’attestation active et remet le verdict numérique à son état calculé, en conservant le scan et l’historique. Après décision, l’attestation, le document utilisé et le rattachement sont protégés. Le terminal opérateur peut enregistrer la fiche, jamais prononcer une libération qualité.

## Migration

`20261014_autocontrol_capture_1328.sql` ajoute une table de captures et quatre gardes : contrôle/source exacte, scan utilisé immuable, absence de mélange avec les mesures, identité/registre de quantités cohérent. Les anciens documents et mesures ne sont pas réécrits. Les préflight/vérification/rollback sont sous `db/patches/support`. Le rollback exige un acquittement explicite et refuse toute capture conservée. Sauvegarder Test/Prod avant toute application réelle.

## Vérification et limite de recette

Tests ciblés du domaine, fichiers réels temporaires, commandes, HTTP terminal et formulaires. PostgreSQL17 : restauration de schéma seulement, application/rejeu, droits `cerp_app`, projection du dossier et rollback vide protégé. Aucune donnée métier copiée. Ces preuves techniques ne valent pas un parcours complet sur le terrain ni une photographie ou impression physique.

Le 14/10, Keenan demande de reporter les scénarios de recette intégrale encore ouverts, de terminer cet autocontrôle et de prévoir une livraison commune avec le chantier inscription/paramétrage. Aucun déploiement indépendant ni nettoyage de la Base Test ne doit être déclaré à partir de ces preuves. Les nouvelles éditions du PDF rappellent le scan obligatoire ; les archives antérieures restent inchangées.
