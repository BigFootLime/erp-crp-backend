# OF dossier completion and material coverage

Delivery in progress: backend #767, frontend #1025–1032, Project Office WP-254. The governing decision is frontend ADR-0072; activation defaults to off.

## Current interfaces

- GET /production/workbench/config includes material_workflow_enabled.
- GET /production/ofs/:id/dossier reads preparation, committed operations, customer/internal/committed/forecast/actual dates and validation blockers.
- POST /production/ofs/:id/complete validates the frozen technical definition and actual committed planning, retaining actor/version evidence. It never starts production.
- GET /production/ofs/:id/material reads frozen purchase needs, their operation configuration, canonical reservations and purchase allocations, FIFO candidates and net shortage.
- POST /production/ofs/:id/material/:sourceRef/configure records the reviewed material specification and debit rule. Changes require dossier revalidation; existing commitments remain.
- POST /production/ofs/:id/material/confirm applies the reviewed selection and creates supplier/currency/destination-compatible purchase drafts for the uncovered quantity.

Writes require expectedVersion and idempotencyKey. Replayed commands validate actor and payload. Coverage uses a locked OF and canonical stock quality/availability gates; drafts use existing purchase numbering, line insertion, creation documents and audit. Failed transactions roll back reservations and purchases together. Prices are removed from the public read model when purchase-price rights are absent.

## Canonical ledgers

of_material_needs attaches specifications to an OF technical version and consuming operation. stock_reservations retains physical quantities, consumed quantities and source identity. commande_fournisseur_ligne_besoin retains future promises; OF_MATERIAL permits separately traced partial promises while the unique-link policy remains for legacy source types. of_material_receipt_transfers links an incoming stock receipt to its resulting reservation and deduplicates reconciliation; it must never be counted as extra physical stock.

The dossier source fingerprint excludes slot dates/resources so ordinary moves do not invalidate the prepared product. Deferred planning triggers see the transaction's final schedule and invalidate only after withdrawal. Definitions and quantities trigger revalidation immediately.

## Rollout and verification

Both additive migrations have preflight/verify files and a recovery guide under db/patches/support. Test first, retain application ownership and migration UTF-8 hashes. Do not remove ledgers for rollback. A disabled UI is not permission to bypass persisted allocations through legacy routes.

Policy tests cover net 40/15, FIFO rejection, shared pool depletion, repeated confirmation, transfer to physical/consumed, quarantine, supplier surplus and explicit bar/sheet conversion. Read probes use cerp_test under cerp_app; trigger checks roll back all their test writes. Business recipe is exclusively through the UI. Full receipt reconciliation, customer calls, supplier consultations and operation start/partial consumption are still being implemented; the presence of a schema or pure function does not imply their delivery.

Point intermédiaire : vérification des caractéristiques des lots réservée à la qualité, preuves liées au besoin et au contexte du lot, certificats provenant des documents actifs de sa réception. Les propositions respectent aussi le disponible commun de l’emplacement. 17 tests de politique réussis. Recette UI sur cerp_test : validation Complet puis revalidation après modification matière vérifiées ; réservation et achat encore en cours de recette.

8 septembre, contrôle matière : les propositions lisent désormais le même contrôle Qualité 360 que la réservation, sans verrou d’écriture en lecture. La quantité libérée est partagée entre les emplacements et les besoins du même lot. Un recontrôle LOT/RECHECK vérifie côté serveur article, unité et population physique ; le circuit de libération des BL reste contrôlé par son périmètre propre. 42 tests ciblés passent. Recette réelle : le lot 892 portait le statut LIBERE sans contrôle quantitatif ; réservation refusée sans création d’achat. Le parcours correctif est en cours de recette sur cerp_test.

Le 8 septembre, l’ouverture du premier contrôle LOT a révélé la contrainte historique quality_control_context_chk, limitée aux OF/pièces/affaires. La migration 20260908_quality_lot_context ajoute un contexte LOT exact avec article, plan figé et population positive, valide la contrainte élargie puis retire uniquement la contrainte obsolète. Aucune ligne métier modifiée. Sauvegarde test avant intervention : 869e5e2ffb8988d5f573e2522e50cc246c42b32519a17058fdab99e7cecd3dde. Vérification cerp_app réussie ; production non modifiée. Récupération : désactiver le nouveau parcours en conservant cette contrainte compatible ; ne pas réinstaller une contrainte rejetant les contrôles LOT créés depuis.

## Réception et qualité — implémentation du 8 septembre

La mise en stock, le mouvement comptabilisé, le reçu de commande, les affectations aux besoins destinataires et l’audit partagent maintenant une transaction. Les fonctions stock acceptent la transaction propriétaire ; elles ne la valident ni ne la ferment. Une erreur d’affectation annule l’ensemble. La répétition d’une commande réussie relit son résultat avant de consulter les quantités ou unités qui auraient changé depuis.

`20260908_receipt_unit_snapshot.sql` capture unité de stock et coefficient à la réception, protège leur immutabilité et ajoute l’identité de commande au reçu canonique. Les réceptions anciennes ne sont pas converties rétroactivement : une unité identique reste utilisable ; une conversion ambiguë est refusée. Cette migration doit précéder l’activation du code de réception.

Le contrôle LOT/RECEPTION résout sa ligne, son fournisseur, son article et sa population dans l’unité figée, avant toute entrée physique. Les décisions Qualité alimentent le registre existant et le statut du lot. Une libération partielle conserve la quantité retenue ; un refus ne crée ni retour fournisseur ni achat. La mise en stock compare le cumul des entrées à la quantité libérée sur cette ligne, sans compter ses réservations une seconde fois. L’ancienne décision entrante « LIBERE » renvoie vers le contrôle quantitatif canonique ; ses mesures restent lisibles. La politique indépendante des BL n’est pas modifiée.

50 contrôles techniques ciblés réussis : contexte, unités, décision partielle/refus, éligibilité, transaction et répétition. Les tests de transaction utilisent des doubles pour les registres périphériques ; ils ne constituent pas une preuve de concurrence PostgreSQL ni une recette utilisateur. La recette réelle reste à réaliser après activation test. La décision sur l’auto-approbation qualité des superutilisateurs reste en attente ; aucun assouplissement n’est appliqué.

## Consultations fournisseur — L4 en cours

`GET /commandes-fournisseurs/:id/consultations` lit la consultation courante et son historique ; `round` permet d’ouvrir un tour précédent. `POST /commandes-fournisseurs/:id/consultations/commands` accepte OPEN, INVITE, RECORD_OFFER, SELECT et CLOSE. Lecture et écritures exigent les capacités achats et prix ; toute commande porte une clé d’idempotence et la version exacte du brouillon, puis la version de consultation pour ses modifications.

La consultation fige quantités, unités, exigences et dates d’un brouillon existant. Les demandes sont des textes préparés pour relecture, jamais des mails envoyés. Les réponses sont ajoutées avec révision et motif de correction ; les précédentes restent lisibles. La comparaison expose les totaux calculés par le moteur d’achat existant, les devises séparées, les surplus et retards. Prix et dates fournisseur ne sont pas inventés par le formulaire.

Un choix explicite et motivé applique fournisseur/conditions/prix/quantités à ce même brouillon, en transaction. Il conserve les liens vers les besoins et les réservations, ne crée pas un autre achat, ne valide pas la commande et ne transforme pas la date d’offre en AR. Il refuse une offre expirée, corrigée depuis, étrangère, insuffisante ou dont la conformité reste à vérifier. Le réordonnancement des clés jsonb est neutralisé lors de la comparaison du contenu figé. Une commande ou une exigence modifiée impose une nouvelle consultation ; aucune offre existante n’est réécrite silencieusement. Les changements sont publiés via l’outbox et les invalidations achats/OF existantes.

Migration additive `20260908_supplier_consultations.sql`, avec précontrôle, vérification cerp_app et récupération conservant les historiques. Les contrôles techniques ont couvert calcul, contenu figé, refus, répétition, rollback et conservation des affectations avec doubles SQL. Une recette UI réelle et une mesure de concurrence PostgreSQL restent requises avant clôture. Les pièces jointes GED des consultations, les appels de bruts client et le démarrage/débit par opération sont encore à terminer.

Recette UI du 8 septembre, 02 h 22 : BCF-2026-0924, deux demandes fictives, réponse Rhône 108 € HT corrigée de v1 à v2 avec raison, réponse Alpes 93 € HT / 50 u / surplus 10 u retenue avec motif. Même BCF toujours brouillon, fournisseur Alpes, total 111,60 € TTC, aucune promesse AR créée. Ce dossier distinct ne possède pas d’affectation OF : la conservation d’une affectation réelle reste à exercer. API test ebfe61f2 ; production 37684605 inchangée. Voir le journal frontend pour sauvegarde et empreintes.

Correction suivante : la date de besoin du brouillon est reprise si celle de ligne est absente, pour ne pas masquer un délai tardif. Les consultations déjà figées restent inchangées ; une différence de contenu réclame un nouveau tour. L’édition générique d’une ligne acquiert le verrou planning puis protège les affectations : identité article/type/unités/conversion conservée et quantité nette suffisante pour les destinataires, avec conversion vers l’unité canonique des allocations OF_MATERIAL. Quatre tests de cette garde réussis, plus les 48 tests consultation/HTTP ; activation test de cette correction encore à faire.

## Disponibilité par opération — 8 septembre, 03 h 05, L5 en cours

La lecture `GET /production/ofs/:id/operation-readiness` distingue dossier, créneau engagé, programme applicable, quantités physiques compatibles et transferts réellement libérés. Une matière réservée de 60 bruts sur 100 ouvre un plafond de 60 uniquement si sa règle autorise le partiel. Le programme TASK provient de la tâche de version terminée avec référence ; une ligne de calendrier programmation ne prouve pas sa réalisation. Les lots et documents applicables restent soumis à leur autorité qualité/GED.

Les démarrages canoniques et anciens acquièrent les verrous planning → OF → lots qualité, relisent les conditions et enregistrent le premier démarrage effectif de l’OF. L’ancienne libération globale ne peut pas démarrer ce parcours. Les écritures libres du cumul OF et des états RUNNING/DONE d’opération renvoient aux commandes de production. Après déclaration, le cumul bon de l’OF provient de sa dernière opération active, les étapes précédentes restant des encours ; les rebuts sont suivis à leur opération.

Une déclaration tient compte des quantités bonnes, rebutées, à contrôler et à reprendre dans le plafond. Sur l’opération matière, la consommation effective doit précéder la déclaration de bruts. Cette protection est prête ; le formulaire et la transaction de débit partiel/chutes sont encore à livrer, il ne s’agit pas d’un parcours matière terminé. Les corrections de quantités et transferts devront conserver cette même cohérence.

La reprise d’un pointage clôturé par Pause ouvre un segment à la date de reprise et conserve le segment précédent. Un successeur déjà créé interdit un deuxième effet. L’aperçu de quantité utilise une transaction de lecture cohérente et le contrôle de confirmation relit son état. 108 tests ciblés passent : politiques quantité/disponibilité, autorisations et routes OF/exécution, dont reprise sans durée de pause. Les lectures SQL opérations/dépendances ont été exercées sans écriture sur OF 852 ; aucune autorisation de démarrage réel n’est encore prouvée par la recette UI. Les compteurs de matière consommée restent conservés après expiration d’une réserve ; seul son reliquat expiré cesse de couvrir le besoin.

Activation test 1d7ccba6 : sauvegarde 485a66febffacbbab2eb02115f36dc1e192ebeba1289840e6633cfc13cfc444d, archive bfa1f007dac47646de6dce5e91bee537c5d6aa9358f3a15a541db08c9bc49f3a. Santé test et production vérifiée ; production 37684605 conservée. La recette UI a confirmé dossier Complet non démarré, découpe sans quantité utilisable et tournage en attente de programme/transfert. Un défaut de durée au poste a été trouvé : lecture du temps de gamme à la place de la charge pour l’OF. Le poste reprend maintenant la formule canonique existante et expose les pauses sans successeur pour proposer Reprendre. 53 tests routes/charge passent ; ces deux corrections attendent leur prochaine activation test.


### Reprise du 8 septembre, contrôle technique avant activation

- Worktrees existants repris après interruption ; aucun historique ni travail antérieur supprimé. Décision explicite de KEENAN reçue : auto-validation qualité réservée aux superutilisateurs actifs avec justification obligatoire. Droit relu en transaction, justification et exception tracées.
- Débit raccordé au stock canonique, à la déclaration par opération et au transfert optionnel dans une transaction commune. Le scénario 20 sur 60 conserve 40 réservés. Les échecs de déclaration et de transfert remontent au propriétaire de la transaction. Formulaire atelier avec proposition relue, quantités et intention de nouvelle tentative conservées.
- Vérification : 344 tests ciblés réussis (qualité, consommation partielle, orchestration du débit et propriété de transaction) ; compilations TypeScript backend et frontend réussies. Ces tests utilisent des doubles et ne remplacent pas la recette métier ni une preuve de concurrence PostgreSQL réelle.
- WP-254 actualisé par interface. Recette UI et extensions chutes/corrections, couverture future, bruts client, GED et révisions restent en cours.


### Recette 60/40 et démarrage — 8 septembre

CQ-921 : refus UI sans justification, puis libération de 79 u avec justification explicite de recette. OF-852 : réservation confirmée de 60 u et création du brouillon BCF-2026-0925 de 40 u. La découpe affiche 60 utilisables ; le tournage conserve ses blocages programme et transfert.

Le démarrage a révélé deux backstops historiques : programme global SQL puis preuve immuable de libération de l’OF. Le premier est désormais limité à l’opération figée pour un dossier Complet ; la vérification PostgreSQL annulée autorise la découpe et refuse toujours le tournage. Le démarrage effectif enregistre désormais sa portée opération/quantité dans le registre immuable existant of_release_decisions, avant de passer l’OF En cours. Aucun trigger ni contrôle de libération n’est retiré. La poursuite de la recette vérifie ces corrections.


### Reprise du 8 septembre — stock futur fournisseur

La confirmation accepte des futureSelections facultatives (compatibilité des anciennes requêtes conservée) avec ligne, quantité en unité de stock et vérification explicite des exigences. Les affectations utilisent le registre existant commande_fournisseur_ligne_besoin, sans création de commande supplémentaire pour ces quantités. Les achats et lignes sont verrouillés, la version est relue, le disponible est partagé entre besoins ; une erreur de réservation annule aussi les affectations futures. Le disponible vaut quantité nette convertie moins le maximum des affectations et des réceptions, sans double déduction.

Les anciennes affectations en unité d’achat sont converties avant comparaison et rapprochement de réception. Une réception déjà arrivée sans destinataire doit d’abord être traitée au stock : elle n’est pas réattribuée rétroactivement comme une promesse future. Le serveur conserve les blocages de propriété, unité et destination ; les exigences particulières restent à contrôler sur le lot physique. Les dimensions minimales figurent désormais dans les exigences des nouveaux brouillons.

36 tests ciblés réussis (calculs et orchestration future, couverture, transaction de réception). Ces tests avec doubles ne prouvent pas la concurrence PostgreSQL. Compilation TypeScript réussie avant activation ; recette UI de la couverture future à réaliser.

Le démarrage réel de la découpe OF 852 et le débit de 20 bruts ont réussi sur cerp_test : nécessaire 100, réservé 40, consommé 20, attendu 40. Le pointage a été arrêté par interface, sans terminer l’opération. Le programme du tournage reste un prérequis indépendant.

La première lecture UI a révélé une validation trop large des colonnes descriptives de la ligne achat. Le contrôle porte désormais sur les cinq quantités uniquement ; un test sur la forme réelle de la ligne protège ce cas. 19 tests ciblés et compilation complète réussis après correction.


### Bruts client — préparation de la recette du 8 septembre

Appels client rattachés aux besoins, exigences figées, demande préparée/transmise/date annoncée, annulation motivée avant toute réception et réceptions partielles. La référence de transmission est enregistrée ; aucun message externe n’est envoyé par cette commande. Une réception client utilise le registre existant des réceptions, avec origine CUSTOMER, fournisseur absent et client propriétaire explicite. Ligne, lot en attente, audits et commande d’idempotence partagent la transaction. Les certificats et contrôles utilisent les parcours existants ; les quantités libérées seront automatiquement réservées au besoin destinataire dans la même transaction que la mise en stock.

Migration additive 20260908_customer_material_calls.sql préparée, pas encore appliquée à ce point. Garde SQL d’origine client/article/unité et conservation du propriétaire sur les lots. Les routes historiques ne peuvent ajouter une ligne client sans son appel. Pas de nouvelle source de vérité stock ni de fournisseur fictif.

20 tests serveur spécifiques réussis, plus 23 tests de non-régression réception/qualité/confirmation. 10 tests frontend réception réussis, TypeScript frontend/backend et compilation complète backend vérifiés. La recette UI reste à faire avant de déclarer ce circuit livré.

Couverture future effectivement exercée par UI sur OF-906 : préparation pour 30 pièces, réservation de 5 bruts et affectation de 25 du BCF-0924 existant, zéro nouveau brouillon. Une seconde confirmation conserve 5 réservés / 25 attendus et ne crée rien. BCF-0924 garde 25 unités libres. OF-852 conserve 40 réservés / 20 consommés / 40 attendus.

Migration client appliquée et vérifiée sur cerp_test : empreinte 7d9076748d36f5fe31b4415d8f9706a530a5890798f28717d535d350c77eab0c. Sauvegarde préalable d2d62c0eaf832c9599d4a728a393711abeed7e2ac0f58f51880df5c322d65964. Aucune migration de production. Compilation complète : 1229 opérations HTTP inventoriées et contrat validé.

### Réception client vérifiée et solde futur affiné — 8 septembre

Recette UI client réussie sur OF-856 : appel 40 u, réception RF-00000003 de 15 u, lot client LOT-926, plan PC-927 publié depuis le contexte article, contrôle CQ-928 avec 15 mesures fictives conformes et justification de libération par le superutilisateur auteur. Après mise en stock canonique : 15 réservés physiques et 25 attendus, zéro manque et zéro réception bloquée. Le dossier demeure À compléter, aucune commande fournisseur ni message externe créé. Arrivée du solde annoncée au 14 septembre, sans modification du planning engagé. Détails et références dans le journal frontend.

Les affectations futures enregistrent maintenant le début de leur plage dans les quantités réceptionnées. Une attribution de 30 sur un achat de 100 ayant déjà reçu 20 commence à 20 ; elle laisse 50 futurs libres. Les 20 déjà reçus ne changent pas de destinataire. Une nouvelle réception de 30 couvre cette affectation même si les 20 précédents restent en quarantaine. Les mises en stock utilisent l’intersection des plages de réception et de promesse ; chaque mise en stock partielle et son affectation restent idempotentes.

Le regroupement automatique peut compléter un brouillon du même fournisseur, de la même devise et destination. Une empreinte du contenu complet (en-tête, lignes, affectations) impose qu’il soit resté intact. Toute modification acheteur, consultation ou réception exclut le brouillon. Les lignes existantes sont conservées ; seules de nouvelles lignes sont ajoutées. Les brouillons antérieurs sans empreinte ne sont jamais repris implicitement.

Migration `20260908_material_future_offsets.sql` appliquée sur test uniquement, empreinte `2161f1e3bf219e53bec35d9eb3f34bf1a03602fa8b6737aa913b606bac524773`, sauvegarde `cerp_test.before-material-future-offsets.dump` vérifiée : `d63d2409c5982c4615cc365ddcda0d4930b1fa2bcfa6ddb4fb3f0c3d3368e1e5`. Six requêtes réelles des repositories vérifiées par PREPARE/EXPLAIN PostgreSQL dans une transaction de lecture annulée. 42 tests ciblés réussis et compilation complète 1 229 opérations vérifiée. Ces ajouts attendent leur activation API test et leur recette UI ; la préparation du débit avec chutes et corrections et les autres lots restent ouverts.

### Débits mesurés, chutes, retours et compensation — 8 septembre, préparation de recette

Les prélèvements BAR/SHEET peuvent différer du calcul avec une justification de dix caractères ; le rendement de tôle reste validé par les méthodes. Les bruts unitaires conservent leur conversion exacte. La preuve lie quantité prévue et sortie réelle. Leur écart ajuste le besoin restant sans modifier la déclaration de bruts ni provoquer un deuxième achat du même avancement. Le stock source montre le prélèvement brut ; une chute crée une entrée distincte, d’où la consommation nette globale.

Chaque chute crée un nouveau lot EN_ATTENTE, avec dimensions mesurées, même article, propriétaire, référence fournisseur et filiation canonique TRANSFORM. Les certificats actifs des réceptions sources restent consultables via cette filiation ; aucune décision de libération n’est copiée. Tout échec de création, de mouvement ou de filiation annule aussi la consommation et la déclaration du débit.

Les bruts gardés au poste peuvent être transférés ultérieurement. Les sorties et retours modifient le registre canonique des lots de transfert et ajoutent des événements immuables motivés. Un retour est refusé après démarrage ou déclaration de l’étape suivante. La compensation complète d’un débit exige leur retour préalable et des chutes non utilisées. Elle crée les mouvements inverses, restaure les réservations non expirées et ajoute une déclaration et des preuves signées négatives. Les écritures d’origine restent intactes ; l’opérateur peut alors saisir son débit corrigé. Le parcours de compensation générique stock renvoie vers l’OF pour ces écritures.

Migration `20260908_material_remnants.sql` appliquée uniquement sur cerp_test, empreinte `c415ec926ecc9c22cfb448c6f318cfb2952f90e926285bcc745d70b54ce28797`. Sauvegarde préalable vérifiée `cerp_test.before-material-remnants.dump` : `95ff24f32fb8a29de0ae629a95ca1c38d5fc548fbe74679fc62323528d20526e`. Vérification des contraintes et lecture cerp_app réussies. 58 requêtes source passent PREPARE/EXPLAIN dans une transaction de lecture annulée ; cela ne prouve ni leur exécution métier ni la concurrence. 260 tests production/stock réussis, 14 tests d’intégration conditionnels ignorés ; 110 tests HTTP/exécution/stock réussis. Compilation complète 1 231 opérations HTTP réussie. Activation API et recette UI de ces ajouts à effectuer.

KEENAN demande explicitement ensuite la mise en production et le déploiement. Cette étape est autorisée après achèvement des travaux et vérifications ; l’API de production est encore inchangée à ce point.

### Lecture du lot et reprise de contexte — 8 septembre
Le dossier de lot expose le propriétaire client, les propriétés matière et les quantités physiques/réservées issues de stock_batches. La généalogie des chutes reste reliée à ses écritures. Aucun statut qualité n’est déduit de la filiation. Lecture vérifiée avec PREPARE/EXPLAIN PostgreSQL sous cerp_app dans une transaction READ ONLY annulée ; compilation et contrat OpenAPI complets réussis.

### Reprise de chute non libérée lors d’une compensation
La recette UI OF-856 a refusé la compensation du débit 4 bruts / 5 u / chute 0,5 u, sans conserver d’écriture partielle. Correction : la comptabilisation canonique reconnaît uniquement une reprise intégrale de chute par sa preuve immuable, son entrée initiale, sa quantité, son lot et son emplacement. Elle exige la transaction de compensation OF et refuse une chute déplacée, utilisée ou réservée. Le statut qualité demeure inchangé ; aucune sortie de fabrication ordinaire n’est autorisée. Quinze tests ciblés réussis, 60 requêtes PREPARE/EXPLAIN testées sans exécution, compilation complète réussie. Nouvelle recette UI à poursuivre après activation test.

### Rapprochement explicite des engagements entre définitions
Une décision immuable reprend les engagements compatibles sur un besoin actuel ou les conserve séparément avec un motif. La vue de destination suit les chaînes de rapprochement ; les clés d’origine des réservations, achats, appels et débits ne sont pas modifiées. Les besoins actuels lisent les réservations, promesses et écarts de débit une seule fois. Les réceptions client/fournisseur et la consommation canonique suivent la même destination. Les exigences des lots restent à vérifier dans le contexte actuel. Les exigences achetées incompatibles ne sont pas réinterprétées silencieusement. Un débit déjà tracé fige sa règle de conversion et son opération.
La commande exige les droits de préparation et de réservation, une version relue et une intention idempotente. Les engagements séparés restent conservés et doivent être traités dans leurs dossiers ; aucune commande ni réservation n’est annulée automatiquement. L’historique conserve les pièces du rapprochement, l’auteur et le motif. Le dossier Complet est à revalider.
Migration additive 20260908_material_revision_reconciliation.sql appliquée seulement à cerp_test, SHA-256 1d259598b055e62df4d12bcca7b714dd4c4dde0df3c5d3ee68bd75e28ec1327f ; sauvegarde préalable 0cdfd24919553d6bbae5e045df32845feb9c7caaf824c6d38f429ef8c6b38d06. Vérification sous cerp_app réussie. 370 tests production/stock et HTTP réussis, 14 tests conditionnels ignorés ; 81 requêtes réelles PREPARE/EXPLAIN en transaction READ ONLY annulée. Compilation complète et 1 232 opérations OpenAPI validées. Les tests de transaction utilisent des doubles ; recette UI à poursuivre après activation.

Une modification de préparation déjà couverte conserve désormais la ligne précédente, même si l’indice de pièce reste identique : l’unicité concerne la préparation courante. Les anciennes clés des engagements restent intactes et une décision de rapprochement est requise. Une soumission inchangée ne crée pas de nouvelle histoire. Comparaison des configurations par contenu canonique pour résister à l’ordre des clés JSONB. Les exigences des débits déjà tracés ne peuvent pas être réinterprétées. Dix tests ciblés et compilation complète réussis ; la migration material_need_history et sa bascule applicative doivent être coordonnées car l’ancienne clause ON CONFLICT n’est plus compatible.
`nRevalidation en cours de fabrication : un dossier validé auparavant peut être revalidé En cours / En pause après revue de ses exigences et du planning. Un dossier clos ou une validation initiale rétroactive reste refusé. Les anciens engagements non rapprochés bloquent aussi la préparation de nouveaux appels client. Vérification ciblée : 17 tests dossier et appels client réussis, compilation complète réussie.

### Documents des consultations et prévisions durables — 8 septembre
Chaque demande fournisseur conserve une sélection explicite de versions GED, leur titre, numéro et empreinte. Le serveur limite la sélection aux besoins de cet achat, relit l'accès au parent GED et exige une version applicable ; pour un OF figé, sa version doit figurer dans la preuve technique figée. Le contenu est servi par la GED existante. Les versions indisponibles sont signalées et restent visibles dans la sélection jusqu'à une décision explicite.

La file planning_recalculation_jobs est désormais consommée par un processus borné (une exécution par base, au plus 2 000 opérations actives, horizon 180 jours). Stock, qualité, appels client, promesses, réceptions, préparation et GED déclenchent l'invalidation durable. Les échecs conservent les travaux en attente et une erreur limitée ; reprise automatique toutes les 30 secondes, actualisation temporelle après 30 minutes sans événement. L'estimation complète attend tout le reliquat et ne transforme pas une promesse dépassée en réception. Les créneaux, ressources engagées et dates réelles ne sont pas écrits. L'état et les motifs sont exposés dans le dossier OF et le planning.

Migrations test uniquement : consultation_documents SHA-256 6e9c0b3d122c356f9212584620e176ffc5d48ca57c9406fe820a889878b761de ; material_forecasts 010fafc836ceecfa6d115b45a2c0db097ef8d3451bcb7c603bea7f2e71f5730b. Sauvegardes avant ces migrations : 13416c2292798f872282635cdc49b4a912bd79ba27c06633a43d6ac520f80ed0 et b9fafa90fc2004c96f14f43d25062df2c7b1d68c58b0023c16568858d3ac386c. Preflight et vérifications sous cerp_app réussis. 124 requêtes réelles PREPARE/EXPLAIN sans exécution, 382 tests production/stock/planning/achats réussis, 27 tests conditionnels ignorés ; quatre tests spécifiques du périmètre documentaire réussis séparément. La recette UI des nouvelles extensions reste à terminer à ce point.

Recette à 10 h 18 : le recalcul tourne sur cerp_test. Un programme déjà terminé hors fenêtre était omis des données chargées, ce qui bloquait artificiellement ses successeurs. Le calcul charge maintenant tous les prédécesseurs requis et prend leur date réelle de fin ; les dépendances automatiques suivent uniquement la révision active et la tâche de programmation figée. 25 tests de planification ciblés réussis ; nouvelle compilation complète réussie.
