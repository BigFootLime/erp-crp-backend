# Numérotation de bascule CERP (#1710)

Le patch `20261020_cutover_numbering_1710.sql` prépare les compteurs de bascule
sans les activer. Son application seule ne modifie aucune numérotation utilisée
par l'ERP.

## État préparé

| Périmètre | Proposition | Format après activation |
| --- | ---: | --- |
| Affaires de livraison | 24000 | `AFF-LIV-26-24000` |
| Bons de livraison | 15000 | `BL-26-15000` |

Le compteur numérique ne repart jamais à zéro en janvier. L'année affichée est
calculée dans le fuseau Europe/Paris : une affaire créée après le changement
d'année devient par exemple `AFF-LIV-27-24538`.

## Activation contrôlée

Le futur circuit de bascule doit appeler, dans la même transaction auditée et
après MFA SuperAdmin :

- `activateCutoverBusinessNumberSequenceTx` pour les affaires et BL ;
- `activateCutoverFinanceSharedSeriesTx` pour la série fiscale commune.

Une activation refuse une baisse, une réinitialisation ou une seconde
configuration active. Tant que l'activation n'a pas eu lieu, les générateurs
conservent exactement les anciens formats et compteurs.

## Finance

Les factures classiques, factures d'acompte (type 386) et avoirs utilisent une
série numérique commune seulement après activation explicite. Les préfixes de
facture et d'avoir peuvent rester différents, mais chaque émission consomme le
même numéro suivant. Les proformas restent indépendantes sur
`proforma_client_reference_seq`.

Avant d'activer la série fiscale, le circuit vérifie qu'aucune séquence légale
historique active ne doit être arbitrée. Il exige le dernier numéro réellement
émis, les préfixes retenus, l'émetteur, l'année concernée et une référence de
preuve. Aucun chiffre financier n'est prérempli par le patch.

Les références historiques sont immuables et restent compatibles avec les
validateurs de code.
