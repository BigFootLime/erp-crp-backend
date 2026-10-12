# Prélèvement d’urgence et récupération — #1033 / #1034

Parent : frontend #1252. Project Office : FLUX-20261009-06, recette WP285/S06. La session Project Office attend le MFA ; les preuves locales et GitHub restent à y rattacher.

## État du chantier

Le contrôle des donneurs, les OF brouillons, l’approbation du planificateur, le transfert atomique, le forfait unique par commande et le retour des réceptions conformes à l’affaire donneuse sont implémentés côté serveur. L’interface guidée est disponible dans la PR frontend #1478. **L’annulation après engagement, l’ajout à un regroupement en cours et la recette authentifiée restent à terminer.** Cette étape ne termine ni #1033, ni #1034, ni S06. Le lot n’est pas déployé.

`GET /livraisons/affaires/allocations/:allocationId/urgency-preview?quantity=…` exige une session et la capacité livraison `read`. Le calcul lit un instantané PostgreSQL repeatable-read en lecture seule. Il réutilise le contrôle canonique du stock libre, puis recherche uniquement les réservations d’un même client et article sur la piste physique DELIVERY. Il exclut la piste assemblage, les affaires annulées, les réservations expirées, les incompatibilités techniques et les quantités déjà préparées pour un BL. Les lots NEW passent le contrôle Qualité existant pour la totalité des engagements actuels, sans ajouter une seconde fois la réservation donneuse. OLD conserve l’exigence de ses références documentaires.

Les capacités physiques des lots et emplacements sont partagées entre candidats ; les autres réservations et les quantités préparées sont protégées. Les dates initiales d’AR restent inchangées. La date à protéger est la première échéance active non entièrement livrée de l’affaire donneuse ; aucune date n’est fabriquée. Les donneurs les moins proches de leur échéance sont proposés d’abord. La réponse conserve `can_withdraw=false` et signale les limites de recherche. Le hash décrit le contrôle ; il ne constitue pas une validation de récupération.

## Suite obligatoire

1. Annulation après engagement/prélèvement, avec réconciliation des engagements et conservation des preuves. L’annulation des arbres encore inutilisés est disponible.
2. #1034 : ajout au producteur seulement avant découpe terminée, définition exacte, limites lots matière, recalcul explicite sans déplacement silencieux d’autres clients.
3. Recette normale Test du parcours guidé, des réceptions partielles après qualité et du forfait unique en BL partiels, facture et avoir ; preuves puis déploiement.

## Demandes et OF brouillons

- `GET /livraisons/affaires/allocations/:allocationId/urgency-requests` : historique de l’affaire.
- `POST` au même chemin : quantité décimale exacte, hash de la proposition, motif et en-tête `Idempotency-Key` UUID. Capacité livraison `allocate`.
- `POST /livraisons/urgency-requests/:requestId/cancel` : version attendue et motif. Même capacité.

Le stock libre doit être réservé avant la demande ; si le prélèvement ne couvre pas entièrement le reste demandé, la création est refusée. Une demande active par affaire est autorisée. Les propositions en attente sont soustraites des nouvelles propositions sans modifier les réservations physiques des donneurs. Les verrous et la relecture du contrôle empêchent la création depuis un écran périmé. Le rejeu d’une clé restitue la demande existante.

La génération canonique crée un OF par affaire donneuse, même lorsque plusieurs lots lui appartiennent. Il reprend sa commande, sa ligne, son affaire, sa PT et sa version technique, pour la quantité empruntée exacte. L’AR initial et la date actuellement à protéger sont conservés séparément. Les règles d’identité et l’égalité demande = récupérations = sources sont aussi contrôlées par PostgreSQL. La préparation et la planification restent possibles ; l’entrée en exécution reste bloquée tant que la demande attend le planificateur.

L’annulation concerne l’arbre entier d’OF encore en brouillon sans dossier figé, opérations, besoin matière ou réservation. Un dossier engagé exige une réconciliation du planning, qui reste à implémenter. Aucune quantité de stock n’est déplacée ni retirée durant cette préparation ou son annulation. Les preuves ne sont jamais supprimées.

## Vérifications effectuées pour cette étape

141 tests dédiés : propositions, quantités exactes, demandes, rejeu, écrans périmés, génération atomique, annulation, droits et validation HTTP, blocage du démarrage, faisabilité des récupérations, approbation et prélèvement. La vérification inclut les créneaux et leurs marges, alias machine/poste, maintenance, dossiers incomplets, délais avancés, approvisionnements tardifs/bloqués, composants de montage et protection des autres clients. Les tests des droits utilisent le routeur et le middleware de capacité Planning réels, avec une identité de session et un service métier simulés. Les tests de transaction du prélèvement utilisent le gestionnaire de transaction réel avec un accès SQL simulé ; ils vérifient le rollback après échec d’un transfert ou de l’outbox, sans prétendre exécuter le stock PostgreSQL dans Vitest.

58 tests existants du moteur de planning et de disponibilité des opérations avaient également passé lors de l’étape d’approbation. Sur l’étape prélèvement : build TypeScript, frontière des données de production et inventaire OpenAPI (1 468 opérations) : PASS.

Le patch est créé puis intégralement annulé dans une transaction sur `cerp_test` ; 62 requêtes serveur compilent sous le rôle `cerp_app` avec les vraies tables. Trente-trois contrôles PostgreSQL sont exercés dans un schéma isolé avec dépendances synthétiques, puis annulés : identité, quantités, approbations, transferts, interdiction d’un prélèvement incomplet et conservation des preuves. Six autres cas exécutent la requête réelle de diminution de réservation : fraction, version périmée, protection du BL préparé et des consommations, conservation des historiques en retrait partiel ou total. Ces fixtures ne constituent pas une recette métier réelle. Les données ERP existantes et la production ne sont pas modifiées.

Avant toute publication du lot complet : finaliser les étapes restantes, préparer l’interface CERP, effectuer les scénarios S06 sur une session Test normale, puis déployer les migrations/backend/frontend ensemble. Les preuves SQL locales sont `urgency1033-draft-sql-proof.json`, `urgency1033-constraints-proof.json` et `urgency1033-stock-proof.json` dans le dossier d’audit.

## Approbation du planificateur

- `GET /planning/v2/urgency-requests/:requestId/approval-preview` : contrôle sans écriture.
- `POST /planning/v2/urgency-requests/:requestId/approve` : `expected_version`, `preview_hash`, en-tête UUID `Idempotency-Key` ; capacité `manage_schedule` dans le module Planning.

Le contrôle relit les donneurs exacts de la demande, sans soustraire sa propre quantité une seconde fois. Il vérifie les dossiers et toutes les opérations de l’arbre de récupération, leurs engagements, qualifications, calendriers et conflits de capacité au moyen du moteur de planning existant. Les opérations des autres OF restent fixes. Les marges réservées sont également contrôlées, même si le temps calculé est inférieur au créneau.

La fin doit précéder minuit à Paris au début de la date de livraison protégée. Si l’engagement courant a été avancé, le plus proche des deux délais s’applique ; le repousser ne relâche pas la protection initiale. Les arrivages futurs fermes, affectés et utilisables avant leur opération peuvent couvrir le planning ; le démarrage de production conserve le contrôle canonique de toute la matière physique. Pour un montage, les sous-pièces doivent être réservées utilisables ou rattachées à une fabrication de cet arbre, de quantité suffisante, engagée avant le montage. Une même quantité de sous-pièces n’est pas comptée deux fois.

Une transaction sérialisable enregistre l’approbation, sa preuve et ses audits. Un changement concurrent renvoie un conflit explicite ; le rejeu restitue la décision existante. L’état APPROVED conserve la protection des quantités proposées. L’aperçu d’approbation retourne `can_withdraw=false` : seul l’aperçu de prélèvement ci-dessous peut autoriser cette action après son propre contrôle. Les décisions antérieures sont immuables et un renouvellement exige la version courante.

Une exception ciblée permet de placer les nouvelles opérations de récupération malgré l’AR déjà envoyé sur la commande donneuse. Elle concerne uniquement l’OF de récupération et ses descendants actifs ; les autres OF de la commande conservent les contrôles existants. Aucun AR ni délai client n’est modifié.

La sélection d’une récupération active dans une simulation applique automatiquement le périmètre de son client. Les tâches d’autres clients et les producteurs regroupés partagés restent verrouillés, sans dépendre d’un indicateur envoyé par l’interface. Le résultat est revérifié avant application ; une demande qui mélange des récupérations de plusieurs clients est refusée.

## Transfert après approbation

- `GET /livraisons/urgency-requests/:requestId/withdrawal-preview` : capacité livraison `read`, sans cache.
- `POST /livraisons/urgency-requests/:requestId/withdraw` : capacité `allocate`, `expected_version`, `preview_hash` et en-tête UUID `Idempotency-Key`. Quantité, lots, affaires et approbation sont relus côté serveur ; le corps ne peut pas les substituer.

L’approbation lie les définitions techniques, opérations, ressources et créneaux engagés. Un déplacement ou un changement du dossier exige une nouvelle approbation. Le simple avancement des compteurs d’atelier ou d’un planning étranger ne l’expire pas ; qualité, donneurs et faisabilité sont néanmoins recontrôlés à chaque prélèvement.

La mutation verrouille les affaires, réservations, lots, niveaux et emplacements, puis relit le contrôle avant transfert. Le stock physique reste identique. Seule la part non consommée et non préparée au BL quitte la réservation donneuse ; la réservation bénéficiaire passe par l’allocateur canonique et conserve le même article, lot, emplacement, base OLD/NEW et quantité exacte. La couverture du donneur est actualisée même après libération totale de sa réservation. Aucun AR ni indicateur OTD n’est réécrit.

Le journal conserve chaque source et les réservations avant/après. PostgreSQL impose que toutes les sources soient transférées et la demande marquée WITHDRAWN dans la même transaction. L’audit et les notifications des deux commandes font partie de cette transaction. Toute erreur annule l’ensemble ; le rejeu d’une requête déjà enregistrée restitue son résultat sans second prélèvement. Les tableaux d’historique exposent aussi les identifiants d’approbation et de prélèvement.

## Forfait par commande — serveur et facturation

`GET/PUT /clients/:id/urgency-fee` lit/enregistre un montant HT explicite, la devise client et la version attendue. Les rôles d’écriture Client existants s’appliquent ; la modification est auditée et notifiée dans la même transaction. Un montant nul est autorisé explicitement ; une configuration absente ne devient jamais automatiquement gratuite.

La proposition d’urgence affiche le forfait, son taux de TVA repris de la ligne concernée et sa version de paramétrage. Le montant est inclus dans la confirmation et figé dans la demande. Les demandes suivantes de la même commande réutilisent le forfait déjà accepté. Une modification ultérieure de la fiche client ne réécrit pas cet engagement.

Le prélèvement crée la charge une seule fois par commande, dans sa transaction de transfert. Une contrainte unique, des verrous et un journal immuable protègent les demandes concurrentes et les rejeux. Si la charge ne peut pas être enregistrée, les réservations sont également annulées.

Le workflow de facture ajoute automatiquement une ligne `ORDER_CHARGE` pour chaque commande sélectionnée ayant une charge non encore rattachée. Deux BL partiels de la même commande donnent une seule ligne de forfait. Les montants exacts alimentent TVA, échéancier et total ; la remise globale suit le calcul canonique existant. La charge est réservée au brouillon de facture sous verrou, puis réutilisée à son émission. Une charge créée après ce brouillon sera proposée à une facture suivante ; elle ne modifie pas silencieusement le brouillon accepté. La ligne n’est pas une quantité livrée et n’entre pas dans `facture_source_allocations`.

Pour les BL regroupés, la commande de chaque ligne prime sur la commande d’en-tête. PostgreSQL vérifie le client, la devise, la commande réellement livrée, le montant, la TVA et le lien de facture. Le workflow d’avoir peut lire cette ligne de facture comme toute autre ligne ; sa recette authentifiée reste à faire. Un avoir ne supprime pas l’historique du forfait et ne le propose pas à nouveau automatiquement. L’annulation des brouillons de facture n’a pas de route canonique disponible : ne pas supprimer manuellement le lien du forfait.

Vérification de cette étape : 412 tests ciblés Urgence/Finance/démarrage API, puis quatre tests HTTP du forfait avec le middleware réel de rôles Client. Build, TypeScript, frontière de données et OpenAPI (1 470 opérations) passent. Douze requêtes compilent sur le schéma Test avec le rôle applicatif, dans une transaction annulée. Dix-sept contrôles de contraintes exécutés sur un schéma fictif vérifient notamment l’unicité, les BL regroupés, les prix et les écritures immuables. Tous les objets fictifs sont supprimés par rollback ; aucune donnée métier ni base Prod modifiée.

Anomalie détectée et corrigée pendant ces contrôles : PostgreSQL exige un droit UPDATE de colonne pour `FOR UPDATE`. Le rôle applicatif reçoit ce droit uniquement sur l’identifiant de la charge ; le trigger immuable interdit toute véritable modification. Les montants restent non modifiables. Le précontrôle de migration refuse toute ancienne demande active sans prix accepté, afin d’éviter un tarif inventé. Les scripts verify/rollback sont fournis ; le rollback refuse de supprimer des paramètres ou preuves déjà utilisés.

Le lot reste en brouillon, sans migration ni déploiement applicatif. L’interface du forfait, de la demande, de l’approbation et du prélèvement est développée dans la PR frontend #1478, vérifiée avec des données synthétiques en clair/sombre et formats ordinateur/tablette/mobile. La recette S06 authentifiée reste distincte.

## Retour des pièces de récupération — réception et qualité

La réception de l’OF de récupération réutilise les réservations canoniques de livraison et la répartition physique existante des pistes. Elle vise la ligne et l’affaire donneuses conservées dans la demande. Une modification de la commande, de l’affaire ou de la définition de cet OF provoque un conflit explicite, sans redirection silencieuse des pièces.

Seules les quantités conformes réellement réservées après prélèvement sont comptées comme réaffectées. Le journal `delivery_urgency_replenishments` relie chaque quantité à la récupération, à sa réception, au lot et à la réservation. Il conserve aussi le lien d’origine lorsque la réservation est déplacée physiquement vers la piste livraison. Il ne crée aucune seconde entrée physique. Les retours partiels s’additionnent exactement et le surplus reste libre. Si l’affaire a déjà été couverte autrement, la réception n’invente pas une réservation supplémentaire ni un remboursement ; ce cas devra être soldé explicitement dans la réconciliation d’annulation.

Pour un OF regroupé, seule la part attribuée à l’OF source de récupération est éligible. Une libération Qualité répétée ne peut pas réutiliser la même attribution. Les contrôles différés PostgreSQL imposent une réception POSTED du même lot, le bon producteur ou sa part regroupée, une attribution DELIVERY et le respect du total emprunté. Un mouvement en quarantaine, une part libre ou la production d’un autre OF ne comptent pas. La preuve est conservée si la qualité est remise en cause ensuite : elle décrit le mouvement réalisé ; le contrôle Qualité courant reste obligatoire avant livraison.

La production terminée avant le prélèvement reste du stock libre puisque le donneur détient encore ses pièces ; elle n’est pas comptée comme une restitution fictive. L’aperçu d’urgence exige toujours l’utilisation du stock libre avant tout prélèvement.

`GET .../urgency-requests` expose `replenished_quantity` et `remaining_recovery_quantity` par récupération. Le dialogue frontend affiche « réaffectées au donneur » et remplace l’action Planifier par un statut quand la quantité empruntée est entièrement réaffectée. Aucun état d’approbation ni AR initial n’est modifié par une réception. Le patch additif `20261012_delivery_urgency_replenishments_1033.sql` comporte verify et rollback ; le rollback refuse toute suppression de preuve utilisée.

## Protection des récupérations regroupées — préalable #1034

Le contrôle de démarrage suit maintenant les allocations actives d'un producteur regroupé jusqu'aux OF commerciaux et à leurs racines. Une demande en attente du planificateur ou annulée reste bloquante, même depuis une sous-pièce du producteur. Plusieurs chemins vers une même récupération ne la dupliquent pas ; les regroupements dissous et les allocations inactives ne donnent aucun droit courant.

La même lecture identifie le client d'origine lors d'une simulation de planning. Cette protection continue après le prélèvement (`WITHDRAWN`). Les producteurs qui couvrent un autre client, ainsi que leurs sous-pièces, restent fixes. Une étiquette client sur le producteur ne remplace pas l'identité de ses OF sources. La lecture ne prend pas de verrou de demande pendant le calcul optimiste : les commandes gardent leur ordre de verrouillage existant et la validation de révision du planning.

Validation PostgreSQL : SQL réel extrait du repository, tables synthétiques isolées, rôle `cerp_app` avec SELECT seul, puis rollback. Cas couverts : racines, enfants, producteurs imbriqués, chemins multiples, cycles historiques, regroupement dissous, allocation inactive, origine client différente, demande annulée, prélèvement déjà réalisé et sélection vide. Cette correction ne permet pas encore l'ajout d'une récupération à un regroupement en cours : l’aperçu ci-dessous prépare cette décision ; l’application atomique reste à réaliser avant activation de #1034.

Les preuves de cette étape sont `urgency1033-replenishment-validation.json`, `urgency1033-replenishment-sql-proof.json` et `urgency1033-replenishment-constraints-proof.json` dans le dossier d’audit. Les contrôles SQL sont exécutés sur Test puis annulés : 17 requêtes compilées, lecture de verrouillage exercée sous `cerp_app` et 13 groupes de contraintes dans un schéma synthétique. Aucune donnée métier ni base Prod modifiée. Ces tests ne remplacent pas la recette S06 sur une session normale.

## Aperçu de récupération avant la fin de découpe — #1034

`GET /planning/v2/urgency-recoveries/:recoveryId/consolidations/:consolidationId/preview` utilise la capacité Planning `manage_schedule`, deux UUID validés et une transaction `REPEATABLE READ READ ONLY`. La réponse contient `read_only: true`, la faisabilité, les quantités avant/après, la charge supplémentaire, la fin proposée, les délais protégés, les écarts de créneaux et les causes de refus. Le calcul ne constitue ni une approbation ni un prélèvement.

Les deux OF doivent garder le même client, article, PT, version et dossier figé. Les sources commerciales restent distinctes. L’OF de récupération doit être brouillon, sans engagement propre, consommation ni couverture par un autre regroupement. Une découpe clôturée ou une opération déjà terminée impose de garder un OF séparé. Sans découpe identifiable, un regroupement déjà commencé est également refusé.

La charge est calculée par le moteur central et ses calendriers, fermetures, qualifications et capacités machine/poste partagées. Le temps de réglage déjà engagé et les compteurs restent intacts : seule la charge des pièces supplémentaires s’ajoute. L’estimation de la machine affectée prime lorsqu’elle existe. Pour une opération en cours, l’aperçu conserve le début d’origine et refuse une attente avant reprise. Les autres engagements restent fixes, y compris ceux du même client. Une dépendance liée rendue impossible est bloquante ; une alerte indépendante appartenant à un autre OF ne l’est pas.

Le contrôle matière reprend les réservations physiques et la qualité du module existant, ajoute les consommations réelles du producteur et conserve son ajustement de débit. Un achat prévu ne remplace pas une matière disponible. Maximum deux origines matière, une pour une pièce critique, chutes comprises par leur origine. Pour le montage, cette première version exige les sous-pièces physiques réservées utilisables. Les quantités déjà consommées par le producteur restent comptées.

La nouvelle fin doit précéder strictement l’AR initial, l’engagement protégé et le délai courant de l’affaire donneuse, ainsi que les échéances des sources restantes du regroupement. Un AR retiré ou entièrement livré n’est pas utilisé comme engagement courant. Une source interne conserve sa cible de fabrication. Une affaire annulée doit être réconciliée. Aucune date client n’est réécrite.

Limites explicites : les prestations externes demandent encore une proposition fournisseur pour le complément ; elles ne sont pas déclarées faisables. Pas de route d’application ni de bouton opérationnel ajouté pour cet aperçu seul. Restent l’application transactionnelle, le transfert des réservations, la conservation des validations et l’intégration de la récupération dans l’approbation existante. Ce lot reste dans la PR brouillon, sans merge `dev`/`main` ni déploiement intermédiaire.

Preuves : tests du moteur réel avec horaires synthétiques, droits HTTP avec service simulé, assemblage du contexte et transaction en lecture seule, quatre requêtes réelles compilées et exécutées avec des identités vides sur Test, puis huit groupes de cas SQL avec tables synthétiques et SELECT seul sous `cerp_app`. Chaque essai PostgreSQL est intégralement annulé. Les résultats et limites sont consignés dans `urgency1034-preview-validation.json` et `urgency1034-preview-sql-proof.json` du dossier d’audit. La recette S06 authentifiée reste à faire.


## Transfert matière des ajouts de récupération — composant transactionnel interne

Le helper appendRecoveryConsolidationHoldsTx ajoute les réservations inutilisées de la récupération à celles du producteur. Il relit la préparation, les exigences, la qualité, les origines et la version sous verrous lot → stock → réservation. Il conserve les consommations et les quantités préparées du producteur. Une réservation source consommée, préparée, périmée ou incompatible est refusée. Un achat prévu ne remplace pas la matière physique.

Pour le même besoin et lot, la réservation existante est augmentée sans réécrire le journal initial. Une preuve additive conserve chaque source, son montant exact et les compteurs avant ajout. Pour un nouveau lot, une nouvelle réservation et sa preuve initiale sont créées ; le journal indique que cette quantité figure déjà dans la base pour éviter son double comptage. Les dates de validité ne sont jamais prolongées. Les compteurs physiques du stock ne changent pas.

La migration 20261012_recovery_material_extensions_1034.sql et ses scripts verify/rollback sont additifs. Les contraintes différées exigent une allocation active de la quantité exacte de récupération et la conservation des réservations jusqu’au commit. Les preuves ne sont ni modifiables ni supprimables, même par le propriétaire de la table. Le rollback refuse les preuves déjà utilisées. La dissolution canonique reste interdite après consommation ; pour un producteur encore inutilisé, elle prend en compte tous les compléments et ne libère que le surplus réel.

Cette fonction reste privée : le futur appelant doit verrouiller la révision du planning et les OF, puis enregistrer ensemble quantité du producteur, allocation source, dossier actualisé, créneaux et décision du planificateur, dans une transaction SERIALIZABLE. Aucun endpoint d’application ne l’expose à ce stade. Les mouvements de composants, la validation du dossier et le mapping d’approbation restent à intégrer.

Preuves : 20 nouveaux tests du transfert et de la restitution ; compilation des 13 requêtes réelles sur le schéma Test sous cerp_app, exécution des mutations réelles et de la requête de restitution sur données synthétiques, vérification des contraintes immédiates/différées et du rollback. Les transactions sont entièrement annulées ; aucune donnée métier ni Prod modifiée. Les résultats sont conservés dans urgency1034-material-validation.json et urgency1034-material-sql-proof.json du dossier d’audit. Ces contrôles ne remplacent pas la recette S06 authentifiée.

Le transfert matière accepte aussi une obligation de récupération dont le prélèvement est déjà enregistré (WITHDRAWN), conformément à l’aperçu : cela ne crée pas de nouveau prélèvement et ne modifie pas la quantité due. Le futur appelant doit toujours vérifier que l’OF reste brouillon, que la découpe permet encore l’ajout et que tous les délais restent protégés. Le contexte SQL réel et la contrainte d’identité sont testés pour ce cas. Une demande annulée reste refusée.
