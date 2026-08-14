# API ADV fiable — SOL-23

Toutes les routes sont sous `/api/v1/reporting/commercial/adv`, exigent un JWT et sont protégées par les capacités Finance côté serveur.

## Lecture

- `GET /overview` : filtres du reporting 360 (`period`, `from`, `to`, `as_of`, `client_id`, `currency`, `limit`). Renvoie les définitions, la fraîcheur, la fiabilité, la file livraison, l'OTIF, le DSO, le cash à 30 jours, la balance âgée et la complétude e-facture interne.
- `GET /orders/:id/chain` : commande → livraisons → factures → paiements/avoirs/promesses/litiges → preuves de marge.

## Mutations idempotentes

L'en-tête `Idempotency-Key` de 8 à 120 caractères est obligatoire. Réutiliser la même clé avec le même payload renvoie la réponse initiale; un payload différent reçoit `409 IDEMPOTENCY_PAYLOAD_MISMATCH`.

- `POST /deliveries/:id/blocks`
- `POST /delivery-blocks/:id/resolve`
- `POST /invoices/:id/payment-promises`
- `POST /payment-promises/:id/status`
- `POST /invoices/:id/disputes`
- `POST /invoice-disputes/:id/status`

Les clôtures exigent `expected_updated_at` pour refuser une décision sur une version périmée.

## Limite volontaire

`electronic_invoicing.connector.available=false` signifie qu'aucun prestataire n'est sélectionné. `READY_FOR_CONNECTOR` n'est ni un dépôt, ni un envoi, ni une acceptation fiscale.
