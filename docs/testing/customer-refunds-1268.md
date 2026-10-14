# Avoirs payés, remboursements et encaissements après avoir — #1268

Un encaissement ne réduit pas le montant de facture encore corrigeable par avoir. L'avoir reste plafonné par la facture et par les quantités/montants de ses lignes d'origine. Il peut créer un crédit client ; le remboursement est ensuite plafonné par ce crédit et par la trésorerie effectivement reçue. Le remboursement ne doit jamais rouvrir artificiellement une dette.

Les routes Finance `POST /paiements/workflow/refunds/preview` et `register` déterminent les paiements d'origine côté serveur. Elles sélectionnent des affectations directes, d'anciens règlements directs ou des avances réellement reprises sur la facture. Les budgets du paiement, de son affectation et de l'origine sont partagés : deux origines liées au même paiement ne doublent pas la trésorerie disponible. Les fonds déjà réservés à une facture finale ne sont pas remboursables depuis l'acompte initial.

La commande enregistre un remboursement déjà exécuté et sa référence bancaire. Elle ne déclenche aucun virement. Le montant, les dates réelles, le mode et la référence restent des faits explicitement saisis et validés ; les identifiants de client, paiement et origine ne sont pas des choix libres du navigateur. Une empreinte périmée est refusée et la clé d'idempotence conserve le résultat d'une reprise. Les capacités `payment_register` et `payment_allocate`, la transaction, l'audit, l'événement et l'outbox restent obligatoires.

## TVA et comptabilité

L'avoir d'acompte conserve la correction de TVA non encaissée puis déjà encaissée, par catégorie. L'export débite les avances et les comptes de TVA correspondants ; un remboursement crédite la banque et débite le client sans deuxième correction de TVA. Aucun remboursement ne transforme l'acompte en vente.

Un paiement ultérieur sur un acompte réduit utilise une preuve de version2 : montant encore dû, TVA en attente, avoirs qualifiés et remboursements déjà enregistrés. Il ne reconnaît que la TVA restante proportionnellement à cette dette restante. Les preuves de version1 déjà émises et leurs écritures restent intactes. Les catégories sont monotones et le dernier encaissement reprend exactement les centimes restants. Un ancien avoir sans preuve fiscale qualifiée reste bloquant ; aucun backfill n'est inventé.

Exemple exercé : acompte120, avoir60 avant encaissement, paiements40 puis20 ; TVA6,67 puis3,33, banque60, avances50, TVA collectée10, TVA en attente0 et solde client0. Les autres parcours exercés utilisent deux encaissements80+40, deux avoirs60 et deux remboursements60 ; banque, avances, TVA et compte client reviennent à0, sans doublon au replay.

## Migration et erreurs reproduites

`20261014_customer_refunds_1268.sql` ajoute les preuves immuables de remboursement et leurs origines, les garde-fous de solde et le septième type de source comptable. Le rôle applicatif dispose de SELECT/INSERT sur ces preuves, sans UPDATE/DELETE. Les définitions exactes des fonctions préalables sont conservées dans une table privée pour le rollback. Un rollback sans acquittement ou après remboursement, export lié ou encaissement version2 est refusé. La migration préalable de TVA d'acompte n'est pas réécrite.

- Le rôle applicatif ne pouvait pas lire un remboursement avec `FOR UPDATE` : ce verrou nécessitait un droit UPDATE contraire à l'immutabilité. Le verrou global Finance sérialise déjà les écritures ; seule la lecture verrouillée inutile de l'en-tête a été retirée, sans élargir les droits.
- Le test de remboursement excessif a reproduit une dette réouverte de0,01 ; le calcul refuse désormais tout remboursement dépassant le véritable surplus.
- Une fixture manquait d'auteur, une autre comparait un bigint PostgreSQL à un number, puis un numéro fictif dépassait30 caractères. Les fixtures ont été corrigées ; aucune contrainte ERP n'a été assouplie.

## Preuves et limites

Compilation stricte :1497 opérations API,1421 fichiers runtime. Suite complète :7945 tests passent dans721 fichiers ;254 tests dans31 fichiers restent ignorés par la suite existante. Les tests ciblés couvrent les dettes/crédits, les origines partagées, l'autorisation et les dates, les TVA d'avoirs et les encaissements après avoir.

Qualification PostgreSQL17 au rôle applicatif, dans une base jetable issue du schéma Test : application, réapplication, vérification, rollback vide, refus de rollback avec preuve, commandes réelles de paiement/remboursement et replays, exports comptables réellement générés et contrôles d'immutabilité. Les états d'émission fiscale initiaux sont explicitement simulés. Aucun virement externe, aucune émission fiscale normale ni recette UI complète n'est revendiqué. Test/Prod live ne sont pas modifiés.

Ce lot reste en brouillon vers dev et n'est pas déployé. Restent les avoirs d'acompte d'un montant arbitraire, les contrepassations/remboursements annulés, le contrat et les écrans frontend, les reprises, la GED et l'émission Finance réelle, puis la recette fiscale/métier et le déploiement sauvegardé. La recette globale n'est pas clôturée par ces tests techniques.
