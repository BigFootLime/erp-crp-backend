# API Facturation, avoirs et paiements — issue #227

Préfixe : `/api/v1`. Toutes les routes sont authentifiées et protégées par une
capacité Finance exacte. Toutes les mutations de workflow exigent
`Idempotency-Key` (8 à 200 caractères).

Le rôle `Administrateur Systeme et Reseau` dispose de toutes les capacités
Finance. Les autres rôles restent évalués par capacité et les rôles inconnus
sont refusés. Cette autorisation ne désactive ni la séparation des tâches sur
un même document ni les écritures d'audit.

## Facture

- `GET /factures/workflow/eligible-sources`
- `POST /factures/workflow/preview`
- `POST /factures/workflow/drafts`
- `POST /factures/workflow/:id/request-validation`
- `POST /factures/workflow/:id/validate`
- `POST /factures/workflow/:id/issue`

L'aperçu reçoit le client, la devise, les lignes source BL, les quantités et
l'échéancier. Pour une échéance unique, le montant absent est rempli par le
total TTC calculé par le serveur. Le brouillon exige le `preview_hash`.
Validation et émission portent `expected_version`; l'émission porte également
le hash et `confirm: true`.

Statuts : `DRAFT → PENDING_VALIDATION → APPROVED → ISSUED`. Les états de
paiement sont dérivés des allocations; une facture émise n'est jamais
réécrite ni supprimée.

## Avoir

- `GET /avoirs/workflow/invoices/:id/eligible-lines`
- `POST /avoirs/workflow/preview`
- `POST /avoirs/workflow/drafts`
- `POST /avoirs/workflow/:id/request-validation`
- `POST /avoirs/workflow/:id/validate`
- `POST /avoirs/workflow/:id/issue`

Chaque ligne reste rattachée à une ligne de facture émise. Le serveur soustrait
les quantités déjà créditées sous verrou et refuse tout dépassement. Le motif
codifié et son explication sont obligatoires.

## Paiement

- `POST /paiements/workflow/register`
- `POST /paiements/workflow/:id/allocations`

Les montants sont des chaînes décimales exactes. L'enregistrement accepte zéro
ou plusieurs allocations `FACTURE`/`ECHEANCE`; chaque allocation contrôle le
client, la devise, le disponible du paiement et le solde de la cible dans la
même transaction. Un paiement enregistré est immuable et ne se supprime pas.

## Garanties transactionnelles

- reçu d'idempotence et hash de requête par acteur;
- verrous ordonnés sur sources, documents, échéances et cibles;
- séquence légale par type/entité/année, verrouillée sans `MAX()+1`;
- totaux exacts `BigInt`, quantité 3 décimales, prix/taux 4, monnaie 2,
  arrondi half-up documenté comme règle technique à valider;
- snapshot client/émetteur/lignes/totaux et PDF version 1 avec SHA-256;
- journal Finance, audit global et outbox écrits dans la transaction;
- aucune facture créée automatiquement depuis commande, OF, réception, stock,
  expédition ou `DELIVERY.SHIPPED`.

## Activation

Le patch `db/patches/20260725_facturation_payments_227.sql` ne crée aucune
politique ni séquence active. Finance et Juridique doivent valider puis
configurer ces lignes sur `cerp_test` avant toute recette d'émission. Aucune
migration n'a été exécutée pendant l'implémentation.
