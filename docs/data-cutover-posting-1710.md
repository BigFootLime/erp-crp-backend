# Chargement contrôlé des reprises 1710

Le module de reprise permet maintenant de préparer **et d'appliquer** un lot
validé depuis `POST /api/v1/data-cutover/batches/:id/apply`. Il ne remplace pas
les parcours métier existants : il ne réémet aucun document ancien et ne rejoue
aucun mouvement historique.

## Accès et parcours API

Toutes les routes demandent une session authentifiée. Les opérations suivantes
sont réservées au **SuperAdmin** avec une assurance MFA récente : création du
dossier, aperçu, validation, export, gestion des contributeurs, aperçu
applicatif, application, lecture des états d'ouverture et liaison/lecture des
preuves GED.

Les contributeurs ne peuvent consulter et modifier que les domaines qui leur
sont attribués dans leur dossier. Ils ne peuvent ni valider ni appliquer un lot.
La mise à jour d'une fiche porte sa version attendue ; une version dépassée est
refusée. Chaque mutation exige une `Idempotency-Key`.

1. Créer le dossier avec les manifestes figés et les lignes source.
   Le premier dépôt place le verrou financier en `PREPARING` : les nouvelles
   émissions de factures, acomptes, avoirs et proformas restent dans Excel
   jusqu'à l'activation séparée. Un avertissement est présenté avant dépôt.
2. Rapprocher les cibles CERP, compléter les données manquantes et choisir les
   lignes à inclure.
3. Produire l'aperçu avec une heure d'arrêt (`cutoff_at`), puis signer la
   préparation avec la checklist.
4. Exécuter `POST .../application-preview` avec la version du dossier.
5. Après sauvegarde référencée, arrêt du périmètre et confirmations explicites,
   appeler `POST .../apply` avec la version et l'empreinte de l'aperçu.
6. Conserver le reçu d'application et contrôler les écritures natives créées.

Les retours `409` signalent notamment une version, un aperçu ou une dépendance
obsolète, une réutilisation incompatible de clé d'idempotence, un lot non
validé, une ligne déjà appliquée avec un contenu différent, ou un bloqueur
métier. Aucun sous-ensemble n'est publié en cas d'échec : les adaptateurs, le
crosswalk, le reçu, l'audit et l'outbox sont dans la même transaction
PostgreSQL.

## Garanties techniques

- Les sources, manifestes, valeurs sources et événements de préparation sont
  immuables. Une correction crée une nouvelle version de fiche et invalide la
  validation et l'aperçu précédents.
- Les rapprochements appliqués conservent une empreinte des valeurs et de la
  source. Une reprise contradictoire est refusée au lieu de créer une seconde
  cible silencieuse.
- Les preuves GED sont liées par identifiant de document après contrôle de l'ACL
  GED native. La liaison enregistre le titre, le nom, le hash, la taille et
  l'identifiant de la version courante ; aucun chemin local ou partage réseau
  n'est servi. Toute nouvelle liaison invalide la validation du dossier.
- L'application est limitée à 200 lignes par transaction. Les écritures sont
  sérialisées, idempotentes et journalisées ; les effets externes restent à
  `false`.
- Les compteurs d'affaires, BL, factures et proformas ne sont pas activés par
  ce module. Leur activation reste une opération distincte, après le relevé
  des derniers numéros réellement émis.

## Flux actuellement qualifiés

### Stock historique OLD

Une ligne `OPENING_STOCK` validée peut appeler le writer historique natif :
lot, emplacement, qualité, propriétaire, origine `OLD`, mouvement d'entrée et
provenance sont écrits dans la même transaction. Le writer refuse une valeur,
une réservation, un propriétaire ou un emplacement qu'il ne peut pas préserver.
Il ne duplique pas un mouvement lors de la répétition de la même clé.

`OLD` décrit l'origine du lot ; il reste distinct des pistes opérationnelles
`FREE`, `DELIVERY` et `ASSEMBLY`. Les futures productions CERP sont `NEW` après
réception validée. Une même référence peut donc avoir des lots OLD et NEW.

### Commandes et besoins de reliquat

Le moteur prépare de nouvelles commandes CERP pour les quantités restantes,
sans inventer une commande client pour une fabrication interne et sans rejouer
les quantités déjà livrées ou reçues. Les anciennes références restent des
preuves historiques. Les adaptateurs commande sont soumis au même aperçu,
verrouillage, crosswalk et reçu. Les trois writers natifs (client, fournisseur,
interne) ont été exercés sur une copie vide du schéma réel. Un essai complet
client → pièce technique → article → commande confirme la création d'un
reliquat de 30 pour une commande de 100 dont 70 déjà réalisés, avec les vrais
liens natifs et sans création d'OF, BL, AR ou mouvement de stock.

### Encours, finance et livré/reçu non facturé

Les domaines WIP, impayés/dettes et livré/reçu historique créent uniquement des
**états d'ouverture append-only** marqués `OPENING_REVIEW_REQUIRED`. Ils ne
créent ni OF, ni pointage historique, ni facture, ni règlement, ni entrée ou
sortie de stock. Leur rattachement ultérieur à une cible native est un parcours
métier distinct et doit rester vérifié.

## Limites assumées et blocages

- La création d'un nouvel article matière dans une reprise reste bloquée tant
  que l'adaptateur natif ne peut pas préserver son référentiel matière complet.
- Les appels de contrat en devise non EUR restent bloqués.
- Les domaines `METROLOGY` et `LEGACY_PROFORMA` n'ont pas encore d'adaptateur
  d'application ; ils restent archivés/préparés, sans écriture métier.
- Une ancienne livraison ou réception non facturée ne génère pas une seconde
  sortie/entrée de stock ni une facture fiscale. Elle reste un état à
  rapprocher.
- Le bleu/vert, la sauvegarde/restauration et l'activation des compteurs sont
  des procédures de release séparées. Une restauration globale après des
  saisies réelles doit être évitée au profit d'une correction tracée.

## Preuves de test disponibles

Les tests PostgreSQL isolés suivants ont été exécutés sur une base dédiée avec
données synthétiques, sans écriture dans les bases métier :

- Ouverture WIP/finance append-only, stock OLD natif avec qualité/propriétaire/
  provenance, répétition idempotente et rollback transactionnel.
- Trois commandes natives (client, fournisseur, interne), un parcours complet
  de référentiels vers une commande, deux essais stock sur le schéma réel
  (matière et pièce finie, version technique et unité contrôlées).
- 6 tests PostgreSQL du moteur d'application et 11 tests PostgreSQL de
  préparation, exécutés par l'équipe de reprise.
- Après l'exécution des contrôles complets, les contrats de test suivent explicitement
  le générateur inactif d'affaires et la fonction transactionnelle d'achat
  extraite : 43 tests ciblés réussis. Le contrôle append-only reste inchangé ;
  la fixture OLD conserve désormais ses journaux au lieu de les nettoyer.
  Les deux essais OLD et les trois commandes natives ont été rejoués avec
  PostgreSQL et réussissent.

Cette preuve qualifie le périmètre indiqué ; elle ne vaut ni recette
utilisateur complète, ni déclaration de conformité, ni activation des données
de production.

## Déploiement et retour arrière

Appliquer les patches dans l'ordre `01` préparation, `02` preuves GED, `03`
états d'ouverture, `04` application et `05` verrou financier, puis le patch de
numérotation additive inactive, avec les scripts `preflight` et `verify`
associés. Réaliser une sauvegarde cohérente base + GED avant toute application
réelle et consigner son identifiant dans le checkpoint d'application.

Le rollback SQL ne doit jamais effacer une preuve, un reçu ou une écriture
métier déjà utilisés. Avant toute première application réelle, le retour
consiste à restaurer une version logicielle compatible et à garder les tables
additives. Pendant `PREPARING`, cette version doit aussi appliquer le verrou
financier ; un backend antérieur à ce garde n'est pas un retour qualifié.
Après application, employer une correction métier tracée ou une restauration
coordonnée de la sauvegarde pré-bascule, jamais une suppression manuelle des
lignes de reprise.
