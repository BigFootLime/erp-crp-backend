# Provenance matière et traitement du lot produit

LOT1310 est produit par OF95. Le stock et le contrôle du BL montraient l'OF mais MP/TR vides : ils ne lisaient que les références historiques libres. Les preuves métier existaient pourtant : deux débits POSTED non compensés et deux retours de traitement dans la clôture immuable de l'opération30.

Une projection partagée conserve les références historiques et ajoute les lots enregistrés dans ces preuves. Le traitement est reconnu par la préparation d'achat figée de type TRAITEMENT, reliée au dossier, à l'opération, à l'origine et à la ligne de réception. Une sous-traitance quelconque n'est pas renommée traitement. Les débits corrigés ou non postés n'ajoutent pas de nouvelle provenance. Les codes sont dédupliqués par les lecteurs ; aucun stock, certificat ou lien historique n'est créé à la main.

Douze lectures utilisent la même projection : panier de réservation du BL, vérification, détail des allocations, préparation et vues de stock. Les contrôles de qualité, quantités, scan, verrouillage, correction et expédition restent inchangés. L'expression SQL est une référence interne statique validée, jamais une valeur saisie par l'utilisateur.

Validation :7651 tests/688 fichiers et compilation stricte1479 opérations API. Le contrat structurel de réservation vérifie maintenant le module extrait et son SQL rendu ; les autres assertions de sécurité et d'idempotence sont conservées. Le lecteur compilé réel, sous cerp_app en transaction READ ONLY sur Base Test, retrouve MP1253/1254 et TR1305/1306. Aucun changement de données ou contrôle physique réel n'est revendiqué.

Le rejeu du BL reste à effectuer après déploiement. La généalogie récursive d'un montage et la répartition exacte par origine dans les variantes regroupées restent à qualifier dans la recette globale ; cette lecture n'attribue pas artificiellement chaque pièce à un seul des lots d'un producteur autorisé à en utiliser deux.
