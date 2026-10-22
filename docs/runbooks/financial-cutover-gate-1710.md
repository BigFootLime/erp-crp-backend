# Verrou financier de bascule 1710

Le patch `20261020_05_financial_cutover_gate_1710.sql` crée un état durable unique :
`IDLE`, `PREPARING` ou `ACTIVE`. En dehors d'une reprise, il démarre à `IDLE` et
ne change aucun parcours Finance existant.

## Préparer la reprise

Lors de la création du premier dossier de préparation, le backend appelle
`startFinancialCutoverPreparationTx` dans la même transaction. L'état passe à
`PREPARING` et laisse les commandes, les stocks et les brouillons non financiers
disponibles. Il bloque avec une réponse 409 explicite toute allocation de numéro
de facture, d'acompte ou d'avoir, ainsi que la création ou l'émission d'une
proforma. Les nouvelles émissions restent donc dans Excel.

Le verrou prend un verrou PostgreSQL partagé pendant une émission et exclusif
pendant le passage en préparation : une émission déjà engagée termine avant la
suspension, sans course entre les deux opérations.

## Activer le jour de bascule

1. Arrêter les émissions Excel de la série concernée et conserver la preuve des
   derniers numéros réellement émis.
2. Faire valider par le SuperAdmin MFA la série commune factures/acompte/avoirs,
   puis sa prochaine valeur, sans inventer de numéro.
3. Vérifier la prochaine proforma : son année doit être l'année courante du
   serveur, elle ne peut pas être inférieure à la prochaine valeur de séquence
   ni à un numéro déjà consommé.
4. Dans la même transaction contrôlée, activer la série commune puis appeler
   `activateFinancialCutoverEmissionTx` avec la preuve de validation.

Après l'activation, une nouvelle année ne peut jamais revenir aux anciennes
séries séparées. La série commune de la nouvelle période doit être configurée
et validée avant la première émission ; l'ERP répond alors clairement plutôt
que d'inventer ou de reprendre un ancien numéro.

L'activation enregistre un événement append-only. PostgreSQL ne rend pas
`setval` transactionnel : un échec ultérieur peut laisser un saut de numéro,
mais le système refuse tout retour arrière ou réattribution.

## Retour arrière et bleu/vert

Pendant `PREPARING` ou `ACTIVE`, les deux versions bleu et vert doivent inclure
ce patch et ce garde serveur. Revenir vers un backend antérieur est incompatible :
il pourrait appeler l'ancienne séquence de proformas sans voir le verrou. Le
retour logiciel ne remet jamais les compteurs ni les données de reprise à zéro.
