# CERP Android — intégration backend #1038

Le plan approuvé ajoute `/api/v1/terminals`, l’authentification autonome des tablettes,
la projection du dossier OF et l’exécution native. Le poste web conserve son contrat.
Livraison de code pour revue et pilote ; activation de production non réalisée.

## Activation et migration

Appliquer le journal existant, puis `20260908_android_automatic_time_1038.sql` et
`20260908_android_terminals_1038.sql` sur une base de répétition isolée. Les scripts
`db/patches/support/20260908_android_terminals_1038.preflight.sql` et `.verify.sql`
contrôlent les prérequis et invariants. Aucun de ces patches n’a été exécuté sur
PostgreSQL pendant cette implémentation : **répétition SQL requise avant pilote**.

Configurer `TERMINAL_PIN_PEPPER` (secret aléatoire, 32 caractères minimum, hors base
et Git), puis `CERP_ANDROID_TERMINALS_ENABLED=true` uniquement sur l’environnement
de test. Par défaut la surface terminal répond 503, y compris son administration.
Utiliser HTTPS ; masque des PIN et en-têtes ajouté au logger structuré. Ne pas
activer d’inspection des corps et en-têtes sensibles au proxy.

Les nouvelles tables stockent empreintes, liens de session, compteurs et audit.
`cerp_app` reçoit les droits explicites requis. Les pointages historiques ne sont
pas réécrits. L’index personnel actif et, si présente, l’exclusion temporelle
personnelle excluent la nouvelle catégorie `AUTO_MACHINE` ; les contraintes machine
restent actives. La catégorie a des contraintes de sémantique fixes. Répéter les
patches avec une donnée contenant des chevauchements historiques et contrôler le
coût des verrous DDL sur un clone représentatif.

## Règles de sécurité et de métier

- Appairage à usage unique (15 min) et secret aléatoire appareil. Le code public
  TAB ne sert jamais de preuve. Sessions natives liées à l’appareil/PIN/compte.
- Création du lien natif et ouverture de session dans la même transaction du
  service station. Changement de personne ferme la session précédente de ce terminal.
- PIN HMAC avec secret serveur et site, unique tant que non révoqué ; cinq échecs
  terminal bloquent cinq minutes, compteur de site supplémentaire. Un PIN de compte
  inactif reste réservé jusqu’à révocation, évitant une réattribution implicite.
- Droits Production et type OPERATOR revérifiés. Pas de route générale ERP ouverte,
  pas de décision/libération qualité native et pas de commande stock.
- Téléchargements : périmètre machine → manifeste OF → version/empreinte → contrôle
  antivirus/quarantaine → coffre GED → audit → envoi sûr. Le dossier publié donne
  à l’opérateur un droit de lecture sur ces versions précises ; il ne lui donne pas
  le droit de parcourir toute la GED. Une version remplacée reste consultable si
  elle est celle figée sur cet OF et n’est pas bloquée par l’antivirus.
- PDF réel `of_self_inspection_sheets`, OF officiel `of_documents`, plans GED et
  certificats des lots affectés. Les cotes ne sont pas extraites arbitrairement du PDF.
- Démarrage/reprise/transition sensible : planning engagé et version fraîche,
  prérequis, confirmation CN et premier article applicable, vérifiés côté serveur.
- `AUTO_MACHINE` compte seulement la machine. Confirmation explicite et transaction
  unique pour libérer l’intervention personnelle ailleurs. Réglage/contrôle ne sont
  pas laissés en automatique. Verrouiller ne termine aucun temps.
- Quantités : aperçus et reçus idempotents existants. Mesures : snapshot OF et
  correction avec version optimiste, motif et reçu idempotent dans la transaction.
- Les agrégats machine/personne natifs couvrent tous les segments RUNNING/DONE de
  l’OF sur la machine ; l’historique détaillé est limité aux 100 derniers segments.
  `fn_production_operation_real_hours` conserve sa sémantique personnelle existante.
  L’indicateur de coût canonique demeure « non calculable » lorsque ses règles/taux
  sont incomplets ; aucun nouveau coût n’est inventé pour cette livraison.

## Contrat et validation

L’OpenAPI décrit `X-Terminal-Device` et `X-Station-Session` comme deux preuves
cumulatives. Documentation détaillée : dépôt `crp-systems-mobile`,
`docs/contracts.md`, `docs/architecture.md`, `docs/pilot.md`, `docs/verification.md`.
L’administration web se trouve dans `/admin/terminals`.

Commandes locales : `npm run typecheck`, `npm run build`, tests ciblés
`src/module/terminals`, `automatic-intervention.test.ts`, production #274,
station #289, offline #331 et Qualité 360 #228. Les tests HTTP et transactions
simulées ne remplacent pas une recette sur PostgreSQL et tablette.

## Retour de version

Désactiver le drapeau terminal en incident. Conserver les patches et le backend
compatible AUTO_MACHINE ; utiliser le poste web pour l’exploitation et les clôtures
habilitées. Ne pas supprimer les audits, reclassifier l’historique ni recréer
l’ancienne exclusion personnelle après des temps automatiques. Conserver APK validé,
empreintes, certificat et version serveur. La distribution industrielle exige une
clé Android CERP et le pilote physique, non fournis par cette livraison de code.

## Pilotage

Issue parente web #1038 ; lots #1039 à #1046. Le Project Office n’a pas reçu de
preuve automatique : variables `CERP_PROJECT_OFFICE_URL`, `CERP_API_TOKEN` et
`CERP_DATABASE` absentes de cet environnement. Reporter le journal de preuves via
le workflow canonique avant de déclarer les lots acceptés. Aucun push automatique.
