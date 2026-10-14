# Avoirs partiels : valeurs d'origine et dernier centime — 14 octobre 2026

Une facture de 100 € HT à 20 % et 100 € HT à 5,5 %, remise globale 5 %, porte 190 € HT / 24,23 € TVA / 214,23 € TTC. Le retour de la première ligne doit créditer 95 € HT / 19 € TVA / 114 € TTC, et non 100/20/120 comme le faisait l'ancien calcul d'avoir.

Les quantités, prix, remises, TVA et montants sont lus dans les lignes figées de l'émission quand elles existent. Un instantané présent mais invalide ne provoque pas un repli vers un prix actuel. Pour les anciens documents sans lignes figées, les faits de stockage conservés sont utilisés. La ventilation documentaire d'origine répartit les bases et taxes exactes sur les lignes ; chaque avoir soustrait les quantités **et** les montants déjà consommés. Un historique contradictoire est bloqué, sans réécriture des anciennes pièces fiscales.

La remise de ligne et la remise globale d'origine se combinent une seule fois dans la ligne d'avoir (10 % puis 5 % = 14,5 %). Leur provenance reste séparée dans l'aperçu et le snapshot. La remise n'est pas appliquée une seconde fois en pied. Le PDF explique brièvement que celle de la facture d'origine est comprise ; les motifs sont imprimés en français, sans codes techniques. Les prix unitaires conservent leurs décimales significatives, Helvetica et zones cadrées suivent la référence approuvée.

Les fractions cumulées reportent le dernier centime. Trois retours d'une pièce sur trois, pour un budget de 95/19/114, donnent 31,67/6,33/38 puis 31,66/6,34/38 puis 31,67/6,33/38. Leur somme égale exactement la facture. Un quatrième retour est refusé. Les montants réellement crédités sont ceux des lignes et des allocations enregistrées, pas un recalcul avec le tarif courant.

## Corrections supplémentaires reproduites

Le parcours natif de création a révélé deux erreurs PostgreSQL 42P08 restées latentes : référence de brouillon partagée entre varchar/text, puis identifiant de ligne partagé entre bigint/text. Les casts explicites uniformisent les paramètres, sans changer leur valeur. Les transactions échouées ont été annulées ; créations et rejeux suivants passent. Les deux preuves d'échec sont conservées dans le journal d'audit local.

Le premier jeu de qualification utilisait un ancien code de motif hors du contrat API. Il est remplacé par QUALITY et passe désormais par les véritables schémas Zod d'aperçu/création avant d'appeler les repositories. Aucun enum de production n'a été assoupli pour le test.

Les quantités sélectionnées sont normalisées à trois décimales dans l'aperçu : « 1 » et sa relecture PostgreSQL « 1.000 » ont la même empreinte. Cette différence de représentation ne peut plus empêcher la validation/émission d'un brouillon inchangé.

## Preuves et portée

- Douze tests de calcul : catégories TVA, remises combinées, tiers successifs, valeurs anciennes arrondies, pièces gratuites, remise complète, quantités et historiques contradictoires.
- Régression repository dédiée : empreinte identique avant/après normalisation de quantité. Suite finale : 7 907 tests / 713 fichiers passent ; 254 tests / 31 fichiers restent ignorés par la suite existante. Build strict : 1 495 opérations et 1 407 sources runtime/émises.
- PostgreSQL 17 isolé depuis le schéma Test seul : aperçu d'avoir et création/rejeu réels, allocation 114 € et PDF de brouillon cohérent. Trois créations successives lisent les vrais crédits consommés, les prix d'origine figés et le dernier centime ; quatrième refusé. Les états fiscaux d'origine/consommation sont explicitement des **fixtures de stockage**, sans émission légale normale, validation Finance, encaissement, remboursement ni recette UI revendiqués.
- Schémas SQL précédents appliqués/rejoués/vérifiés, rollback vide/protégé et perte de précision refusée ; base temporaire supprimée, aucune donnée métier copiée et aucune BDD live changée.
- Un exemple fictif d'une page, 69,67 HT / 13,93 TVA / 83,60 TTC, rendu A4 et visuellement relu ; toutes les zones et notes restent lisibles. Anciennes éditions émises inchangées.

Preuves locales : `proforma1268-credit-budget-{build,full-tests,schema}.log`, `proforma1268-credit-budget-schema-proof.json`, `recette-20261009/evidence/proforma1268-credit-budget-repository.log`, `credit-budget1268-download-proof.json`. Sauvegarde complète ece3586f et dumps Test/Prod du 14 octobre à 03:47:50 UTC relus sur VPS avant la dernière qualification.

## Suite requise avant livraison

L'ancien garde de solde interdit encore un avoir dépassant le montant non réglé : avoirs sur factures déjà payées, remboursement/contrepassation et leurs preuves restent à traiter. La comptabilité des acomptes ne distingue pas encore le type386 d'une vente ni les écritures de TVA encaissée/lettrage final. Ces travaux, l'interface proforma/reprises, la filiation urgente, la GED réelle et la recette fiscale/métier doivent précéder dev/main et le déploiement sauvegardé. La présente correction de calcul/création ne clôture pas ces autres exigences, ni les 12 scénarios complets.
