# Recette OBS-043 — notifications OF et planning

La soumission d'un planning, une proposition de dérive de temps et un dossier AR construisaient un message sans le persister. Le service appelle maintenant le repository canonique des notifications et son outbox dans la transaction de la décision OF.

Les destinataires proviennent du routage configuré et des comptes actifs, y compris leurs rôles complémentaires. Une identité explicitement désignée mais inactive ou absente est exclue. Aucun courriel client n'est émis. Chaque notification ouvre la fiche OF via l'action interne existante.

La clé combine sujet, OF et identité de décision. Deux soumissions distinctes ont deux clés ; le replay d'une même décision ne crée pas de second événement temps réel. Une erreur de persistance ou d'outbox remonte à la transaction propriétaire, qui conserve son mécanisme de rollback.

Validation ciblée : destinataires, doublon, décisions distinctes, sujets désactivés, compte absent, échec d'écriture et échec d'outbox. Compiler le candidat figé et rejouer sur Base Test une soumission réelle avec un destinataire configuré avant de déclarer la communication métier validée.

Ce lot ne change ni les droits d'accès, ni les créneaux du planning, ni la date AR d'origine. Il ne nécessite pas de migration.
