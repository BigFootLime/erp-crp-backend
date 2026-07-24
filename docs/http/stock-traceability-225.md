# API stock et traçabilité — issue #225

Base : `/api/v1/stock`. Toutes les routes sont authentifiées et protégées par
une capacité stock. Les commandes mutantes indiquées ci-dessous exigent
`Idempotency-Key: <8..200 caractères>`.

## Mouvements

| Méthode et route | Effet |
|---|---|
| `GET /analytics` | cockpit autoritaire, `as_of` et périmètre |
| `GET /balances` | disponibilité par article/emplacement/lot |
| `GET /movements` | liste des mouvements |
| `POST /movements/preview` | impact sans écriture |
| `POST /movements` | crée un brouillon idempotent |
| `GET /movements/:id` | détail et corrélations |
| `POST /movements/:id/post` | comptabilise après revalidation |
| `POST /movements/:id/cancel` | annule en conservant la preuve |
| `POST /movements/:id/compensation-preview` | aperçu inverse |
| `POST /movements/:id/compensate` | crée le brouillon compensatoire |

Les sources production, réception fournisseur et sortie BL sont refusées sur
la commande générique. Les modules propriétaires utilisent le service interne
de confiance.

### Dérogation négative

`POST /movements/:id/post` accepte une dérogation uniquement avec la capacité
`negative_stock_override` :

```json
{
  "negative_stock_override": {
    "reason": "Motif industriel contrôlé",
    "max_negative_quantity": 5
  }
}
```

Elle reste refusée pour le stock réservé, déprécié, en quarantaine ou bloqué.

## Réservations

| Méthode et route | Effet |
|---|---|
| `GET /reservations` | liste filtrable |
| `POST /reservations` | crée une réservation active |
| `GET /reservations/:id` | détail |
| `POST /reservations/:id/release` | libère avec version attendue |
| `POST /reservations/:id/consume` | consomme avec mouvement `OUT` posté |

Les types de source autorisés sont `COMMANDE_LIGNE`, `OF`,
`BON_LIVRAISON_LIGNE` et `AFFAIRE`.

## Lots

| Méthode et route | Effet |
|---|---|
| `GET /lots` | liste avec état qualité |
| `POST /lots` | crée un lot |
| `GET /lots/:id` | détail |
| `POST /lots/:id/quality-status` | décision qualité auditée |
| `POST /lots/genealogy` | lien parent/enfant |
| `GET /lots/:id/genealogy` | ascendants, descendants et mouvements |

## Inventaires

| Méthode et route | Effet |
|---|---|
| `POST /inventory-sessions` | crée une session `DRAFT` |
| `POST /inventory-sessions/:id/start` | fige le snapshot et ouvre |
| `GET /inventory-sessions/:id/lines` | lignes gelées |
| `PUT /inventory-sessions/:id/lines` | ajoute une version de comptage |
| `POST /inventory-sessions/:id/approve` | contrôle et approuve |
| `POST /inventory-sessions/:id/cancel` | annule sans effacer |
| `POST /inventory-sessions/:id/close` | crée les ajustements et clôture |

Les retours de conflit utilisent `409`. Les incohérences métier utilisent
`422` lorsque la requête est valide mais impossible à exécuter. Aucun client
ne doit recalculer un solde autoritaire.

## Migration

Le contrat nécessite `20260723_stock_traceability_225.sql`. Exécuter le
préflight et la vérification sur `cerp_test` seulement. Au 2026-07-23, ces
scripts n'ont pas été exécutés : aucune connexion test n'était configurée et
aucune base de production n'a été touchée.
