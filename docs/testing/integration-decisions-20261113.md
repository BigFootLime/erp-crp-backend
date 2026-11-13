# Décisions de réconciliation — 13 novembre 2026

## Version publiée et source consolidée

La livraison urgente 2.0.85 est figée sur frontend
`927630549fbe47457b5634de96a96ac9f5a96528` et backend
`93c84b24548058fd8904bba0b7f7095fc950c6fb`, manifeste
`387cfc50d36854792bbaef99cce5f780250e9df21f54bc1e4cbf790379891d00`.
La consolidation suivante est **2.0.86 — UNRELEASED** côté frontend. Le backend
conserve sa politique de version indépendante. Aucun artefact de cette
consolidation ne remplace implicitement la livraison urgente.

## Révision choisie pour un OF

La chronologie des sources originales établit le contrat, indépendamment des
numéros d'issues frontend/backend :

- `7d0e67df` du 30 octobre 2026 introduit le suivi automatique compatible #1493.
- `3e56c390` du 5 novembre 2026 remplace cette règle : la révision choisie pour
  l'OF reste épinglée, même pour un brouillon portant encore la valeur AUTO.
- `f7fc93c0` du 6 novembre 2026 ajoute la préparation atomique du dossier de
  modification et conserve cette politique. Ses appels au helper historique ne
  réactivent pas le suivi : ce helper refuse désormais tout déplacement.

Le coordinateur a vérifié les dates auteur/committer, l'issue d'origine et le
changement explicite du helper. L'hypothèse provisoire consistant à conserver
le suivi AUTO de l'ancien checkout est donc abandonnée. Les anciennes entrées,
valeurs d'énumération, champs et cas de test restent conservés comme entrées
de compatibilité ; leurs assertions suivent le contrat ultérieur d'épinglage.
Les choix MANUAL, les OF figés, engagés ou validés restent également protégés.

Les surfaces #1833 déjà présentes dans le frontend nécessitent leurs véritables
API backend : familles, liens achats/opérations réversibles, deux finitions,
capacité matière, rentabilité, éligibilité planning, publication du dossier et
retour des problèmes par opération. Les migrations manquantes et leur
dépendance canonique #1831 sont réconciliées avec leurs empreintes d'origine.
Elles ne sont pas appliquées à une base réelle par ce travail Git.

Les dépendances #1834, #1835 et #1836 sont également reprises : ressources de
travail et avancement programmation, prévisions d'approvisionnement, revue
matière et commandes associées. Leurs contrats HTTP, empreintes de revue,
verrous et droits de stock sont conservés ensemble.

La parité #1830/#1832 des traitements conserve une identité PS fondée sur le
plan et l'indice, indépendante du client. Un code déjà utilisé, même archivé,
n'est jamais réattribué. Les liens client passent toujours par le helper
ultérieur dédié, et les transactions empruntées restent celles de l'appelant.
La création directement applicable exige le droit d'approbation de bibliothèque
et crée atomiquement la finition et sa première révision active ; le défaut
reste un brouillon.

## Transactions et instantanés

La consigne utilisateur confirmée le 13 novembre est explicite : tout lecteur
authentifié ayant accès à l'OF peut terminer sa préparation et le valider, sans
visa Qualité. Elle annule la restauration erronée d'une ancienne restriction
de rôle. `can_validate` et `canValidate` suivent cette règle ; les contrôles
d'authentification et d'accès à l'OF restent aux frontières HTTP. Les anciens
cas de rôles sont conservés et vérifient maintenant l'accès à la commande.

La revue matière de finalisation utilise une API Production limitée à la
matière, sans attribuer le module Planning au lecteur. La lecture fournit son
empreinte de revue et masque les prix sans droit d'achat. La modification des
choix fournisseur exige le droit d'achat et ne crée aucune commande dans cette
revue. La finalisation conserve séparément les droits d'achat, de réservation
et de consommation. Le parcours navigateur utilise un lecteur OF sans ces
droits et sans accès Planning pour vérifier cette séparation.

Les clones internes de reconfiguration empruntent la transaction de leur
appelant : aucun BEGIN, COMMIT, ROLLBACK ou release supplémentaire. Ils ne
déplacent aucun OF. La commande publique de nouveau plan exige la confirmation
client et un motif à la frontière HTTP ainsi que dans le repository. L'ouverture
du dossier de travail conserve le plan/indice et réutilise un brouillon existant.

La génération accepte une version non obsolète explicitement choisie ; sans
choix explicite, elle conserve le repli sur une version applicable. L'option
interne existante de reprise historique reste nécessaire pour un dossier
publié devenu obsolète. Les contrôles de complétude et les instantanés figés
continuent de s'appliquer ; aucun choix navigateur ne crée cette autorisation.

## Preuves de recette

La campagne initiale de 402 cas a été interrompue au démarrage du cas 326 pour
la livraison urgente, sur demande utilisateur vérifiée. Ses erreurs et traces
sont conservées ; aucun résultat global réussi n'est attribué à cette campagne.
Les vérifications après reprise utilisent des rapports distincts et les SHAs
de la source consolidée correspondante. Les anciens résultats restent des
preuves de leur source exacte, sans être présentés comme qualification de
changements ultérieurs.
