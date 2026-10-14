# Facture finale : acomptes réels et présentation commune — 14 octobre 2026

## Comportement

Une facture de pièces livrées conserve les quantités, prix, remises, HT et TVA figés de la proforma. Son aperçu attribue les montants TTC réellement encaissés aux affaires/sociétés concernées, puis calcule le net à payer. Un règlement reste enregistré une seule fois sur la facture d'acompte d'origine. Les affectations finales ne créent aucun paiement supplémentaire.

Les parts en euros sont conservées au centime avec des entiers : total documentaire vers lignes, puis lignes vers contributions par affaire. Les fractions net/TVA des acomptes utilisent un cumul arrondi pour conserver le dernier centime entre factures partielles. Les budgets tiennent compte des autres brouillons et factures, des libérations de ventilation et des avoirs consommés. Les budgets, identités, sociétés et devises contradictoires sont refusés.

Les nouvelles preuves sont append-only. La migration additive introduit `proforma_final_prepayments`, les montants payé/dû du document et la provenance du calcul d'une échéance unique. Un montant dû nul est accepté ; aucun centime ni règlement fictif n'est créé pour une facture entièrement prépayée. Les anciennes factures restent sans nouveau montant dû figé et ne sont pas recalculées.

Les contrôles PostgreSQL différés vérifient le montant déduit, les échéances, les budgets de trésorerie d'origine, la valeur livrée et le snapshot émis. Ils refusent la réutilisation d'un acompte, la libération de son argent déjà affecté et le dépassement du montant de la facture par acomptes, règlements et avoirs. Le solde Finance inclut les avances appliquées. La validation/émission recalcule le même aperçu sous le verrou Finance existant.

La facture électronique utilise les faits figés à l'émission : `paid_amount` et `amount_due_for_payment`, conformément au contrat [SUPER PDP](https://www.superpdp.tech/openapi/) et aux termes [BT-113](https://docs.peppol.eu/poacc/billing/3.0/syntax/ubl-invoice/cac-LegalMonetaryTotal/cbc-PrepaidAmount/) / [BT-115](https://docs.peppol.eu/poacc/billing/3.0/syntax/ubl-invoice/cac-LegalMonetaryTotal/cbc-PayableAmount/). Aucun appel de transmission externe n'a été effectué.

## PDF

Factures et avoirs partagent le dessin `structured-v5` de l'OF approuvé : logo CRP, titre centré, référence rouge, Helvetica, cartouches anthracite, grille complète et pied paginé. Les prix unitaires conservent leur précision. Les identifiants de snapshot/règlement ne sont pas imprimés. Une échéance unique est présentée dans le bandeau, avec son terme ; son tableau n'est pas répété lorsque son montant est déjà le net à payer. Les échéanciers multiples et leurs montants restent visibles.

Les acomptes réellement déduits sont distincts des totaux fiscaux, avec référence et date de leurs factures d'origine. Deux exemples fictifs, chacun sur une page, sont générés et visuellement relus. Les PDF déjà émis restent conservés et ne sont pas régénérés.

## Validation et limites

- Suite complète : 7 867 tests / 707 fichiers passent ; 254 tests / 31 fichiers sont toujours ignorés par la suite existante. Des essais intermédiaires ont échoué puis été corrigés ; seule la dernière passe complète est retenue.
- Build strict : inventaire de 1 495 opérations et contrôle de frontière de 1 403 sources runtime/émises.
- PostgreSQL 17, schéma seul copié depuis Test, rôles/permissions conservés : application, rejeu, vérification et rollback vide/protégé ; dépôts de sources et d'affectations exercés réellement.
- Cas monétaires isolés : 80 € payés sur 158,40 € donnent 78,40 € dus ; supplément conservé jusqu'au net nul ; seconde déduction, libération d'argent utilisé, échéance incohérente et encaissement excessif refusés. Les factures et encaissements sous-jacents sont des fixtures de stockage explicitement synthétiques. Il ne s'agit pas d'une émission fiscale normale ni d'une recette utilisateur.
- Les deux exemples PDF sont des démonstrations, pas des factures émises.

Restent avant fusion/déploiement : écriture comptable des acomptes et exigibilité TVA sans double revenu/taxe, ventilation des remises globales en export électronique/comptable, reprise/annulation guidée des brouillons, interface proforma et échéances préremplies, filiation du forfait urgent entre sociétés, classement GED réel et recette des paiements/avoirs/annulations sur Test. Le lot reste en brouillon. Aucun schéma, runtime ou donnée live Test/Prod n'a été modifié par cette qualification. La recette globale reste à 0/12 scénarios intégralement clos.
