# API autoritaire Livraison — issue #226

Le module `src/module/livraisons` est monté sous `/api/v1/livraisons`.

## Écritures critiques

- `GET /preparation-cart` liste les réservations actives disponibles pour
  l'Atelier BL. Les filtres serveur acceptent notamment `q`, `client_id`,
  `commande_id`, `affaire_id` et `source_scope` (`OLD` ou `NEW`).
- `POST /from-reservations` est le point d'entrée autoritaire pour constituer
  un BL depuis les lignes cochées dans l'Atelier. Il consomme une clé
  d'idempotence et refuse les réservations incompatibles ou périmées.
- `POST /:id/status` prépare `READY`, annule avec motif ou déclare livré après
  preuve. Il refuse `SHIPPED`.
- `GET /:id/shipment-preview` calcule l'aperçu sans écriture.
- `POST /:id/ship` exige `Idempotency-Key`, `expected_version` et
  `preview_hash`.
- `POST /:id/proofs` ajoute une preuve append-only.

La confirmation `ship` utilise une transaction unique et des verrous
déterministes. Elle poste les mouvements `OUT` depuis les allocations réelles,
consomme les réservations, écrit event log, audit, outbox et reçu
d'idempotence. Le résultat contient obligatoirement :

```json
{
  "billing_event": "DELIVERY.SHIPPED",
  "invoice_created": false
}
```

Il n'existe aucun import ou appel Facture dans ce flux.

## Frontière avec la commande client

Le lancement d'une commande client réserve le stock disponible et expose les
lignes dans le panier de préparation. Il ne crée et ne prépare plus de BL.
Toute création interactive passe par `POST /from-reservations` dans l'Atelier
BL.

`POST /from-commande` reste temporairement monté pour compatibilité avec les
anciens clients API. Le frontend CERP ne l'utilise plus et ce point d'entrée ne
fait pas partie du nouveau parcours opérateur.

## Patch

`db/patches/20260724_expedition_deliveries_226.sql` et ses scripts
`preflight`, `verify`, `rollback` sont préparés, non exécutés. Le code exige le
patch avant déploiement. Ne pas démarrer le backend #226 sur un schéma ancien.

## Permissions

Capacités : `read`, `prepare`, `allocate`, `ship`, `deliver`, `cancel`,
`documents_manage`, `proof_manage`, `export`. Résolution fail-closed.

## Documents

Les uploads sont contrôlés extension/MIME/signature, limités à 10 × 20 Mo,
hashés SHA-256 et stockés hors exposition publique. `storage_path` n'est jamais
retourné.
