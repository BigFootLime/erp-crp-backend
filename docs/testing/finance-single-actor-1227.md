# Finance : acteur habilité unique — décision métier du 11 octobre 2026

Le décideur a explicitement confirmé que la même personne peut créer, valider
et émettre les factures et avoirs. Cela remplace la séparation obligatoire
décrite dans les documents historiques Finance. Chaque transition reste une
décision distincte, avec les permissions Finance existantes, l'identité réelle,
le numéro de version, l'idempotence et les événements d'audit.

Les comparaisons auteur/valideur/émetteur ne bloquent plus les opérations.
L'ancien champ `require_distinct_issuer` est conservé en stockage historique
pour ne pas réécrire les politiques passées. La réponse de configuration expose
la règle effective `false`. Les requêtes d'anciens clients restent acceptées,
mais toute nouvelle configuration persiste `false`. Pas de migration métier.

Les gardes de qualité, sources externes, solde d'avoir, mentions, séquences,
archive GED et absence d'émission avant APPROVED sont conservées. Les droits
des opérateurs, secrétaires et autres rôles ne sont pas élargis. Cette décision
ne crée aucune transmission PDP ni paiement automatique.

La régression de dépôt teste facture et avoir : approbation de l'auteur,
conflits de statut/version, audit transactionnel, rollback et rejeu idempotent.
La recette UI utilise exclusivement cerp_test, BL56 / DFT-2026-000001.
L'émission et le PDF doivent être constatés avant de déclarer ce parcours réussi.
