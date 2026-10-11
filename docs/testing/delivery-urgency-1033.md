# Prélèvement d’urgence et récupération — #1033 / #1034

Parent : frontend #1252. Project Office : FLUX-20261009-06, recette WP285/S06. La session Project Office attend le MFA ; les preuves locales et GitHub restent à y rattacher.

## État du chantier

Le contrôle des donneurs, la demande persistante, la génération des récupérations en brouillon, leur approbation par le planificateur et l’annulation des brouillons inutilisés sont implémentés côté serveur. **Le prélèvement, le forfait et l’ajout au regroupement restent à implémenter.** Cette étape ne termine ni #1033, ni #1034, ni S06. Aucune action de prélèvement n’est exposée. Ce lot est en développement et n’est pas déployé.

`GET /livraisons/affaires/allocations/:allocationId/urgency-preview?quantity=…` exige une session et la capacité livraison `read`. Le calcul lit un instantané PostgreSQL repeatable-read en lecture seule. Il réutilise le contrôle canonique du stock libre, puis recherche uniquement les réservations d’un même client et article sur la piste physique DELIVERY. Il exclut la piste assemblage, les affaires annulées, les réservations expirées, les incompatibilités techniques et les quantités déjà préparées pour un BL. Les lots NEW passent le contrôle Qualité existant pour la totalité des engagements actuels, sans ajouter une seconde fois la réservation donneuse. OLD conserve l’exigence de ses références documentaires.

Les capacités physiques des lots et emplacements sont partagées entre candidats ; les autres réservations et les quantités préparées sont protégées. Les dates initiales d’AR restent inchangées. La date à protéger est la première échéance active non entièrement livrée de l’affaire donneuse ; aucune date n’est fabriquée. Les donneurs les moins proches de leur échéance sont proposés d’abord. La réponse conserve `can_withdraw=false` et signale les limites de recherche. Le hash décrit le contrôle ; il ne constitue pas une validation de récupération.

## Suite obligatoire

1. Raccorder le forfait figé une fois par commande, son paramétrage client et sa facturation unique, y compris BL partiels.
2. Interface planificateur : exposer le contrôle serveur des opérations et capacités engagées, des approvisionnements confirmés et de la fin réalisable avant l’échéance protégée.
3. Prélèvement transactionnel après relecture de la qualité, disponibilité, versions de réservation/affaire/engagement/planning ; transfert de l’affectation sans créer du stock et sans double couverture.
4. Annulation après engagement/prélèvement, conservation des preuves et remboursement du donneur par la production effective. L’annulation des arbres encore inutilisés est déjà disponible.
5. #1034 : ajout au producteur seulement avant découpe terminée, définition exacte, limites lots matière, recalcul explicite sans déplacement silencieux d’autres clients.
6. Interface guidée CERP, recette normale Test, forfait unique en BL partiels et facturation, preuves et déploiement.

## Demandes et OF brouillons

- `GET /livraisons/affaires/allocations/:allocationId/urgency-requests` : historique de l’affaire.
- `POST` au même chemin : quantité décimale exacte, hash de la proposition, motif et en-tête `Idempotency-Key` UUID. Capacité livraison `allocate`.
- `POST /livraisons/urgency-requests/:requestId/cancel` : version attendue et motif. Même capacité.

Le stock libre doit être réservé avant la demande ; si le prélèvement ne couvre pas entièrement le reste demandé, la création est refusée. Une demande active par affaire est autorisée. Les propositions en attente sont soustraites des nouvelles propositions sans modifier les réservations physiques des donneurs. Les verrous et la relecture du contrôle empêchent la création depuis un écran périmé. Le rejeu d’une clé restitue la demande existante.

La génération canonique crée un OF par affaire donneuse, même lorsque plusieurs lots lui appartiennent. Il reprend sa commande, sa ligne, son affaire, sa PT et sa version technique, pour la quantité empruntée exacte. L’AR initial et la date actuellement à protéger sont conservés séparément. Les règles d’identité et l’égalité demande = récupérations = sources sont aussi contrôlées par PostgreSQL. La préparation et la planification restent possibles ; l’entrée en exécution reste bloquée tant que la demande attend le planificateur.

L’annulation concerne l’arbre entier d’OF encore en brouillon sans dossier figé, opérations, besoin matière ou réservation. Un dossier engagé exige une réconciliation du planning, qui reste à implémenter. Aucune quantité de stock n’est déplacée ni retirée durant cette préparation ou son annulation. Les preuves ne sont jamais supprimées.

## Vérifications effectuées pour cette étape

106 tests dédiés : propositions, quantités exactes, demandes, rejeu, écrans périmés, génération atomique, annulation, droits et validation HTTP, blocage du démarrage, faisabilité des récupérations et approbation. La vérification inclut les créneaux et leurs marges, alias machine/poste, maintenance, dossiers incomplets, délais avancés, approvisionnements tardifs/bloqués, composants de montage et protection des autres clients. Les tests des droits utilisent le routeur et le middleware de capacité Planning réels, avec une identité de session et un service métier simulés.

58 tests existants du moteur de planning et de disponibilité des opérations ont également passé : 164 tests sur cette étape. TypeScript, frontière des données de production et inventaire OpenAPI (1 466 opérations) : PASS.

Le patch est créé puis intégralement annulé dans une transaction sur `cerp_test` ; 40 requêtes serveur compilent sous le rôle `cerp_app` avec les vraies tables. Vingt-trois contrôles PostgreSQL sont exercés dans un schéma isolé avec dépendances synthétiques (`src/__tests__/fixtures/delivery-urgency-1033.*.sql`), puis annulés : les contraintes précédentes, la version et la preuve d’approbation, la conservation des décisions antérieures, et l’exception de planification limitée aux arbres de récupération actifs. Ces fixtures ne constituent pas une recette métier réelle. Les données ERP existantes et la production ne sont pas modifiées.

Avant toute publication du lot complet : finaliser les étapes restantes, préparer l’interface CERP, effectuer les scénarios S06 sur une session Test normale, puis déployer les migrations/backend/frontend ensemble. Les preuves SQL locales sont `urgency1033-draft-sql-proof.json` et `urgency1033-constraints-proof.json` dans le dossier d’audit.

## Approbation du planificateur

- `GET /planning/v2/urgency-requests/:requestId/approval-preview` : contrôle sans écriture.
- `POST /planning/v2/urgency-requests/:requestId/approve` : `expected_version`, `preview_hash`, en-tête UUID `Idempotency-Key` ; capacité `manage_schedule` dans le module Planning.

Le contrôle relit les donneurs exacts de la demande, sans soustraire sa propre quantité une seconde fois. Il vérifie les dossiers et toutes les opérations de l’arbre de récupération, leurs engagements, qualifications, calendriers et conflits de capacité au moyen du moteur de planning existant. Les opérations des autres OF restent fixes. Les marges réservées sont également contrôlées, même si le temps calculé est inférieur au créneau.

La fin doit précéder minuit à Paris au début de la date de livraison protégée. Si l’engagement courant a été avancé, le plus proche des deux délais s’applique ; le repousser ne relâche pas la protection initiale. Les arrivages futurs fermes, affectés et utilisables avant leur opération peuvent couvrir le planning ; le démarrage de production conserve le contrôle canonique de toute la matière physique. Pour un montage, les sous-pièces doivent être réservées utilisables ou rattachées à une fabrication de cet arbre, de quantité suffisante, engagée avant le montage. Une même quantité de sous-pièces n’est pas comptée deux fois.

Une transaction sérialisable enregistre l’approbation, sa preuve et ses audits. Un changement concurrent renvoie un conflit explicite ; le rejeu restitue la décision existante. L’état APPROVED conserve la protection des quantités proposées. Le contrôle retourne encore `can_withdraw=false` : la mutation de prélèvement et sa revalidation restent à raccorder. Les décisions antérieures sont immuables et un renouvellement exige la version courante.

Une exception ciblée permet de placer les nouvelles opérations de récupération malgré l’AR déjà envoyé sur la commande donneuse. Elle concerne uniquement l’OF de récupération et ses descendants actifs ; les autres OF de la commande conservent les contrôles existants. Aucun AR ni délai client n’est modifié.

La sélection d’une récupération active dans une simulation applique automatiquement le périmètre de son client. Les tâches d’autres clients et les producteurs regroupés partagés restent verrouillés, sans dépendre d’un indicateur envoyé par l’interface. Le résultat est revérifié avant application ; une demande qui mélange des récupérations de plusieurs clients est refusée.
