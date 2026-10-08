# ADR-0971 — Composants de montage sur terminal opérateur natif

Date : 2026-10-08. Issue #971 ; dépendance bilan #969/PR970, domaine #956/#959.

Le terminal Android dispose d’une surface étroite sous
`/terminals/operator/ofs/:of_id/operations/:operation_id/assembly-components` :
préparation/bilan, historique de l’opération, aperçu de retour, sortie physique
et retour intégral inutilisé. Les schémas métier et transactions de composants
existants restent propriétaires des quantités, lots, réservations, qualité,
preuves, idempotence et compensations.

Chaque requête reste derrière l’appareil appairé, la session PIN active, le
module Production et le type OPERATOR. La portée exige l’affectation machine
canonique et une seule phase ASSEMBLAGE correspondante dans le dossier figé.
L’aperçu expose uniquement le DTO opérationnel ; l’historique est filtré sur
l’opération. Aucun prix ni accès général GED/Stock/ERP n’est introduit.

Les écritures vérifient la même clé UUID dans le corps et l’en-tête. Elles
recontrôlent le compte, l’appareil, son affectation et délai d’inactivité actuel,
le PIN, la session, le rôle et l’epoch de récupération dans la transaction
propriétaire. Le verrou partagé sur l’epoch d’autorisations sérialise les
révocations ACL avant une nouvelle résolution des droits Production et Stock.
Un droit Production temporaire ne peut pas remplacer les droits Stock.
Ces contrôles précèdent aussi la récupération d’un reçu idempotent.

Les callbacks d’autorisation sont injectés par le serveur, jamais par le JSON.
Les routes JWT existantes conservent leurs règles. Les sorties ne sont pas
déclenchées par un chrono, une déclaration de pièce bonne ou une reprise.
L’interface native doit confirmer la remise physique et conserver la demande
exacte après réponse incertaine ; aucune écriture hors ligne.

Validation incrémentale : TypeScript/OpenAPI et compilation des cinq requêtes
sous cerp_app sur cerp_test, BEGIN READ ONLY / PREPARE / EXPLAIN sans ANALYZE /
ROLLBACK. Tests de portée, identité, epoch et réaffectation préparés pour la
recette finale globale ; aucune exécution métier à cet incrément. Aucun SQL
de migration. Intégration React Native et essai tablette/APK restent à faire.
