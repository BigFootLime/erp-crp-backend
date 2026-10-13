# Proformas, sociétés facturées et couverture des affaires — #1268

## État réel

Développement en cours, WP285 / S07. Les règles de domaine, les DTO, la lecture des commandes et le modèle SQL sont écrits, ainsi que sept opérations HTTP : liste, détail, aperçu, création, aperçu courant, émission commerciale et décision sur les conditions historiques. Les mutations reprennent les capacités Finance, l'idempotence, l'audit et le propriétaire de transaction temps réel avec rapprochement d'un commit incertain. Ces nouvelles routes ne sont pas publiées dans le runtime déployé. Le patch SQL passe une qualification de schéma et de données synthétiques dans une base PostgreSQL 17 isolée ; il n'est appliqué ni sur Test ni sur Prod. Cela ne valide ni un paiement réel ni un parcours métier Test. Les 12 scénarios globaux restent ouverts.

## Règles conservées

- Le client physique de la commande reste distinct des sociétés facturées. Les quantités facturées aux sociétés couvrent exactement la quantité de l'affaire, sans doublon.
- Prix, quantité, remise de ligne, remise globale et TVA viennent de la commande. La requête de création ne peut transmettre aucun prix, statut payé ou instantané faisant autorité.
- La proforma est un document commercial figé, identifié, distinct d'une facture fiscale. Elle n'alloue aucun numéro fiscal.
- La couverture d'une affaire provient de règlements nets déjà affectés à de véritables factures d'acompte. Leur ventilation entre les affaires ne crée pas une seconde entrée d'argent. L'annulation/rejet du paiement, sa libération ou un avoir d'acompte retire la couverture correspondante.
- Les affectations doivent rester dans le montant du règlement et celui de la ligne d'acompte. Les preuves et leurs libérations sont append-only.
- Un BL contient les affaires payées d'une seule proforma ou uniquement les affaires explicitement hors proforma. Les contrôles client/adresse/contrat restent indépendants et obligatoires.
- Les conditions historiques inconnues restent `UNCONFIRMED`. Une décision explicite et motivée doit les régulariser ; aucune reprise silencieuse vers `NOT_REQUIRED`.
- Chaque société facturée doit être couverte. Un excédent chez une société ne compense pas un manque chez l'autre.
- Le contrôle doit être recalculé à la préparation, confirmation et expédition. Le hash commercial change avec quantité, prix, TVA, contrat, adresse ou société facturée ; une modification du planning/stock seule ne le change pas.

## Sources réglementaires pour le circuit des acomptes

La ventilation des paiements s'appuie sur les documents fiscaux de Finance et doit conserver leur traçabilité. Elle ne transforme pas la proforma en facture. Consulter les versions courantes des [opérations donnant lieu à facturation, BOFiP](https://bofip.impots.gouv.fr/bofip/13242-PGP.html) et de [l'exigibilité de TVA sur les acomptes de biens](https://bofip.impots.gouv.fr/bofip/13758-PGP.html/ACTU-2022-00148) lors de la qualification du circuit fiscal. Les choix de régime/territorialité restent ceux du contrat réglementaire Finance.

## Travail de raccordement obligatoire avant livraison du lot

1. Finir et éprouver le patch SQL : cohérence des instantanés, budgets fiscaux, échelonnement des acomptes, avoirs, transferts au solde, préflight/verify/rollback et concurrence.
2. Qualifier les commandes transactionnelles de création/émission et finir les commandes de reprise/annulation des proformas. Les références serveur, RBAC, version, idempotence, audit et outbox de création/émission sont écrits.
3. Activer les sources `DEPOSIT` dans Finance en conservant la validation/émission explicite d'une vraie facture d'acompte. Le trigger Finance actuel les refuse encore : aucune facture fictive ne doit contourner ce blocage.
4. Brancher les ventilations de règlements sur les factures d'acompte émises ; intégrer crédits et annulations du règlement aux lectures et garde-fous serveur.
5. Présenter couverture, solde et action manquante dès la liste des affaires. Ajouter le contrôle aux aperçus puis aux transactions BL ; conserver les preuves de termes dans le document expédié.
6. Autoriser la facturation finale aux sociétés du plan de répartition, avec caps de quantité et déduction des acomptes par société. Ne jamais réallouer le paiement initial une seconde fois sur la facture finale.
7. Créer les écrans guidés et documents PDF CERP, puis les parcours Test payé/non payé/partiel/annulé/avoir, mélanges de périmètres, plusieurs sociétés, BL partiels, retry et concurrence.
8. Sauvegarder avant changement live ; publier branche dédiée → dev → main et déployer BDD/backend/frontend sur Test/Prod, VPS/HYPERBOX2. Rejouer les parcours UI et inscrire leurs preuves avant fermeture de #1268.

## Vérifications locales acquises le 13 octobre

115 tests ciblés passent dans onze fichiers : règles de financement, répartition entre sociétés, frontière BL/proforma, validation des requêtes, source de commande, aperçu, transaction/retry/commit incertain, validation réelle du contrat des événements, HTTP et compatibilité Finance. TypeScript strict et build complet passent ;1486 opérations OpenAPI sont inventoriées et le contrat est valide. Ces tests unitaires et HTTP ne constituent pas une recette UI. La vérification de schéma en lecture seule confirme les prérequis `clients.client_id` varchar(3), les identifiants commande/facture bigint et les contraintes actuelles du journal Finance.

La qualification PostgreSQL restaure uniquement le schéma de Test, avec ses propriétaires et permissions, dans une base dédiée `cerp_qualify_1268_*`. Aucune ligne métier n'est copiée. Une sauvegarde récente Test/Prod a été relue intégralement et vérifiée sur le VPS avant les essais. Application, réapplication, vérification avec `cerp_app`, rollback à vide avec acquittement et refus du rollback sans acquittement passent. La base temporaire est supprimée après chaque essai.

Le [jeu synthétique](fixtures/proforma-affair-model-1268.sql), limité par une garde au nom de la base isolée, prouve la répartition de 100 pièces entre deux sociétés (30/70, 1 200 € TTC), le refus des quantités excessives et des répartitions incomplètes, le gel des lignes après émission, le refus des suppressions d'historique, puis l'annulation sans encaissement et une nouvelle répartition 25/75 conservant l'ancienne. Tous les triggers restent activés. Le test a révélé et corrigé une référence à un champ d'une autre table dans le trigger commun de protection. Les autorisations de `cerp_app` sont maintenant explicites dans le patch. Les budgets d'acompte, encaissements réels, concurrence et factures finales restent à qualifier.

Le modèle conserve les versions précédentes de répartition lorsqu'une proforma annulée est remplacée. La devise de commande est explicite, avec la base EUR déjà utilisée par Finance pour les données existantes ; le rollback ne supprime pas cette preuve commerciale additive. Les mutations prennent le verrou de commande avant le verrou de contrat, conformément au rattachement historique explicite.

L'interface de recette reste bloquée par l'ancienne confirmation native d'annulation. Une session alternative Chrome sur Base Test a été tentée, mais l'authentification du compte existant est refusée. Aucun contournement de mutation métier ou changement d'authentification n'a été effectué.
