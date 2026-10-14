# Acomptes : encaissement, TVA et reprise sur facture finale — #1268

## Comportement

Le type fiscal figé 386 distingue l’acompte de la vente. L’export débite le compte client et crédite les comptes configurés d’avances et de TVA en attente. Il ne remplace pas des comptes manquants par un compte de vente.

Chaque affectation de paiement à un acompte conserve une ventilation de TVA immuable, calculée sous le verrou de la facture avant insertion. L’effet incrémental se base sur le total fiscal original et les encaissements précédents ; les centimes déjà affectés à un taux ne sont jamais déplacés. Le dernier encaissement restitue exactement les budgets de TVA d’origine. Les paiements historiques non qualifiés et les acomptes déjà corrigés par avoir restent explicitement à rapprocher ; aucun backfill ne fabrique de preuve bancaire.

L’export `PAYMENT` inclut automatiquement les sources non bancaires `ADVANCE_VAT`. Celles-ci débitent la TVA en attente et créditent la TVA collectée. La banque est exportée une fois par paiement. `only_unexported`, optionnel et conservé sur le lot, permet un export complémentaire sans réexporter les sources déjà réclamées ; l’ancien mode conserve son refus explicite des doublons.

Avant émission d’une facture finale avec acomptes, `advance_clearing` fige les factures, affectations de paiement, sources, taux et montants repris. Les reprises ne peuvent dépasser la TVA encaissée par catégorie. L’export de la facture finale comptabilise la vente, puis débite les avances et la TVA déjà collectée et crédite le client du TTC déduit, sans mouvement bancaire supplémentaire. Un ancien snapshot incomplet nécessite un rapprochement, sans réécriture de l’émission.

Les comptes `advance_account_by_tax` et `advance_vat_pending_account_by_tax` sont configurables par taux. Aucun compte réel du cabinet n’est choisi automatiquement. Références : [PCG ANC 2026](https://www.anc.gouv.fr/plan-comptable-general-0), [BOFiP, TVA et acomptes sur livraisons de biens](https://bofip.impots.gouv.fr/bofip/534-PGP.html/identifiant=BOI-TVA-BASE-20-10-20221221).

## Stockage et invariants

Migration additive `20261014_advance_cash_vat_1268.sql` : JSONB nullable sur les affectations de paiement, sixième famille de sources/claims comptables, mode complémentaire conservé. Aucune modification des anciennes affectations, tarifs, factures émises ou archives. Le trigger valide identité, empreinte d’origine, montant, chaîne cumulative, catégories fiscales et budgets ; la preuve ne peut être modifiée ni supprimée. Les prérequis, contrôles et rollback sont dans `db/patches/support/`. Le rollback refuse dès qu’une preuve cash ou un lot du nouveau type est conservé.

## Qualification

Tests de domaine : deux paiements 80 + 40 sur un acompte de 120 donnent 13,33 + 6,67 de TVA ; 127 petits paiements à plusieurs taux conservent chaque budget et ne génèrent aucun delta négatif. Chaînes altérées, chevauchements, empreinte différente et encaissement excessif sont refusés. Le cycle acompte120 / vente finale240 produit banque120, vente200, TVA40, client restant120, avances0 et TVA en attente0.

La qualification PostgreSQL17 restaure uniquement le schéma de Test, dans `cerp_qualify_1268_*`, avec données synthétiques explicites et rôle `cerp_app`. Application, rejeu, vérification, rollback vide et refus de rollback avec preuve conservée sont exercés.

Sur un état initial d’acompte émis **simulé**, les deux commandes réelles d’enregistrement de paiement et leurs replays, affectations, états de règlement, aperçus/validations/générations/téléchargements comptables sont exécutés. Le deuxième lot complémentaire ne contient que le nouveau paiement et sa TVA : banque cumulée120, vente0, avances100, TVA collectée20, TVA en attente0. Modification de la preuve et affectation sans preuve sont refusées en SQL. La reprise finale est qualifiée depuis les faits conservés et le ledger commun, sans prétendre à une émission fiscale normale.

Les logs et empreintes exacts sont conservés hors dépôt dans `cerp-audit-flux-20261006/recette-20261009/evidence/` et les proofs de qualification. Le jeu n’utilise aucune ligne métier réelle ; la base temporaire est supprimée après exécution. Test/Prod live restent intacts.

## Limites avant livraison

Lot en branche dédiée/PR en brouillon, pas encore déployé. Contrat frontend/configuration des comptes et mode complémentaire à intégrer puis rejouer ; avoirs d’acomptes déjà encaissés, remboursements et contrepassations à finaliser, ainsi que la reprise des historiques. Les interfaces, véritables émissions Finance, classement GED, cas urgents et recette de bout en bout restent à qualifier. Aucun scénario global n’est clos sur la seule base de ces tests.
