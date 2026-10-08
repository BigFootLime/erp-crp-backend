# Recette 0998 — Base déclarée de coût fabriqué

**Statut : préparée, NON EXÉCUTÉE.** À joindre à la recette commune finale. Utiliser Base Test et des données de recette identifiables ; ne modifier aucun coût ou utilisateur réel de Production.

| Cas | Résultat attendu |
| --- | --- |
| OF avec opérations closes, recalcul ACTUAL récent et coûts complets | Aperçu : coût et quantité préremplis, éligible, DECLARED |
| Coût connu et prix de vente manquant | Base de coût disponible ; aucun prix de vente utilisé |
| Opération ouverte, contrôle en attente ou reprise restante | Aperçu indisponible avec cause métier |
| Quantité/temps/OF modifiés depuis le recalcul | Actualisation requise ; aucune validation silencieuse |
| Coûts manquants, devise/formule non prise en charge, preuves trop denses | Pas de zéro inventé ni de somme partielle présentée comme complète |
| Validation par droit financier snapshot | 201, preuve et audit atomiques ; aucun mouvement physique ni entrée CUMP |
| Même demande réenvoyée par le même acteur | 200 replay, une seule preuve, aucun nouvel audit d'action |
| Même clé avec autre OF, acteur ou SHA | 409, preuve originale conservée |
| Deux validations simultanées d'un OF | Une base unique ; second replay/conflit métier borné |
| Simple lecture reporting, opérateur ou requête non authentifiée | Validation refusée ; droits existants inchangés |
| UUID malformé, OF hors bigint, montant/quantité ajoutés au corps | Rejet de validation avant mutation SQL |
| Réception déjà projetée | Correction financière séparée exigée |
| Modification/suppression/troncature de la preuve | Garde immuable refuse ; aucune preuve perdue |
| Coût 1 EUR / 3 pièces en trois réceptions | Parts exactes 0.333333333333, 0.333333333334, 0.333333333333 ; total 1 |
| Annulation de la première part après la seconde, puis annulation de cette annulation | Montant original restauré/réappliqué exactement ; parenté à prouver par le futur journal |
| Solde exact, coût nul explicite, quantité dépassée ou budget incohérent | Solde conservé ; zéro uniquement connu ; dépassements rejetés |

Les fixtures de domaine sont préparées dans `manufacturing-cost-basis.test.ts` et `manufacturing-cost-allocation.test.ts`. Le journal d'allocation et son raccordement au projecteur appartiennent au prochain lot : cette recette ne vaut pas preuve de leur exécution.
