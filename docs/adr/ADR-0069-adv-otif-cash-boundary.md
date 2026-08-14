# ADR-0069 — Frontière ADV, preuve OTIF et prévision de cash

- Statut : accepté
- Date : 2026-08-14
- Propriétaire : Direction / ADV / Comptabilité
- Contrat : `CERP-ADV-1.0.0`

## Contexte

La facturation sait déjà produire des factures partielles, des avoirs, des échéanciers et des paiements rapprochés. Le reporting commercial expose une balance âgée, mais il ne conserve pas la promesse client au moment où une commande devient intégralement expédiée. Les blocages de livraison, promesses de paiement et litiges de facture ne disposent pas non plus d'une file commune auditée. Calculer le cash attendu en additionnant promesses et échéances créerait un double comptage.

## Décision

1. La facturation existante reste l'autorité des documents, taxes, arrondis, allocations et soldes. SOL-23 ne duplique aucun grand livre.
2. Une preuve OTIF est figée une seule fois à la première complétude d'une commande. Les commandes historiques sans preuve sont calculées depuis l'état courant et portent la fiabilité `PARTIAL`; elles ne sont pas réécrites rétroactivement.
3. L'OTIF est au grain commande : toutes les lignes doivent avoir une date promise, être livrées intégralement et leur date de complétude doit être antérieure ou égale à leur propre date promise.
4. Les blocages sont limités aux catégories `QUALITY`, `DOCUMENT`, `STOCK` et `TRANSPORT`. Ils portent un responsable, une échéance et une prochaine action.
5. Les promesses de paiement et litiges sont des dossiers à transition unique, auditée et idempotente. Leur montant ne peut dépasser le solde de facture connu.
6. Le DSO est calculé séparément par devise : `encours TTC / TTC émis sur 365 jours × 365`. Sans dénominateur, il est indisponible.
7. La prévision de cash à 30 jours affecte d'abord les promesses actives puis les échéances au solde résiduel, avec plafond au solde de facture. L'absence de promesse n'est pas convertie en encaissement certain.
8. La marge reste celle du moteur SOL-13. Le drill-down ne fait que relier les portées `DEVIS`, `AFFAIRE` et `OF` avec leurs snapshots et statuts de fiabilité.
9. Avant le choix d'un prestataire, la facturation électronique n'expose que `NOT_ASSESSED`, `BLOCKED` et `READY_FOR_CONNECTOR`, explicitement qualifiés de complétude interne. Aucun état réglementaire d'échange n'est simulé.

## Sécurité et exploitation

- Lecture financière : capacité backend `reporting_financial`.
- Blocages : `draft_write`; promesses : `payment_register`; litiges : `credit_write`.
- Toute mutation exige `Idempotency-Key`, un hash de payload, une transaction, un événement immuable et un audit ERP.
- Les données restent mono-instance; aucun identifiant société/site n'est inventé.
- Le patch fournit preflight, vérification et rollback limité à `cerp_test` ou à la répétition isolée. En production, le retour arrière est une restauration de sauvegarde dès qu'une preuve a été créée.

## Conséquences

Les nouvelles commandes acquièrent une preuve OTIF forte. La couverture historique reste explicitement partielle jusqu'à extinction naturelle de l'ancien périmètre. Le cash attendu devient explicable et réconciliable, mais n'est pas une prévision statistique. Le futur connecteur de facturation électronique pourra s'appuyer sur la complétude interne sans reprendre un faux cycle de vie externe.
