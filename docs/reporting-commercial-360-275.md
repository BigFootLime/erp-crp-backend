# Reporting commercial 360 — contrat d'API (#275 / back #141)

Base : `/api/v1/reporting/commercial/v2` · Décision :
`crp-systems-web/docs/adr/ADR-0027-reporting-commercial-360.md`

Toutes les routes sont en lecture seule, authentifiées, non mises en cache
(`Cache-Control: no-store, private`) et refusées par défaut.

---

## 1. Surface

| Route | Capacité minimale | Répond à |
|---|---|---|
| `GET /overview` | `reporting_read` | Où en est le commerce sur la période. |
| `GET /quotes` | `reporting_read` | Devis créés, décidés, gagnés, portefeuille ouvert. |
| `GET /orders` | `reporting_read` | Commandes prises, carnet, reste à facturer, retards. |
| `GET /deliveries` | `reporting_read` | Volumes expédiés/livrés, ponctualité, complétude. |
| `GET /invoicing` | `reporting_financial` | Facturé brut, avoirs, facturé net, TVA, encaissements. |
| `GET /receivables` | `reporting_financial` | Encours, échu, balance âgée, non-affectés, trop-perçus. |
| `GET /clients` | `reporting_client_detail` | Classement, concentration, cohortes. |
| `GET /definitions` | `reporting_read` | Catalogue de métriques complet. |
| `GET /drilldown` | `reporting_read` + capacité de l'entité | Liste serveur qui compose un indicateur. |
| `GET /export` | `reporting_export` + capacité de la section | Extraction CSV gouvernée. |

Les trois routes historiques (`/revenue`, `/outstanding`, `/top-clients`) sont
**conservées avec un contrat inchangé** ; seuls leurs agrégats ont été corrigés.

---

## 2. Paramètres communs

| Paramètre | Valeurs | Défaut |
|---|---|---|
| `period` | `current_month`, `last_month`, `current_quarter`, `current_year`, `last_year`, `last_30_days`, `last_90_days`, `last_12_months`, `custom` | `current_month` |
| `from`, `to` | `AAAA-MM-JJ` (requis si `period=custom`) | — |
| `compare` | `none`, `previous_period`, `previous_year` | `previous_period` |
| `as_of` | `AAAA-MM-JJ` | aujourd'hui, en `Europe/Paris` |
| `date_basis` | `document_date`, `issue_date` | `document_date` |
| `granularity` | `day`, `week`, `month`, `quarter`, `year` | `month` |
| `client_id`, `currency`, `order_type`, `commercial_id`, `affaire_id`, `famille` | filtres serveur réels | — |
| `limit` | 1–100 | 10 |

Bornes de période **inclusives des deux côtés**. Une période alignée sur des mois entiers
se compare au bloc de mois précédent ; sinon le comparatif recule d'exactement la durée
demandée. Une combinaison qui produirait plus de 400 points est **refusée** (400
`REPORTING_GRANULARITY_TOO_FINE`) plutôt que tronquée en silence. Une date d'arrêté
antérieure au début de période est refusée (`REPORTING_AS_OF_BEFORE_PERIOD`).

---

## 3. Enveloppe de réponse

```jsonc
{
  "envelope": {
    "as_of": "2026-06-30",
    "period": { "preset": "current_month", "from": "2026-06-01", "to": "2026-06-30" },
    "comparison": { "mode": "previous_period", "from": "2026-05-01", "to": "2026-05-31" },
    "date_basis": "document_date",
    "timezone": "Europe/Paris",
    "granularity": "month",
    "currency": { "currencies": ["EUR"], "mixed": false, "reporting_currency": "EUR" },
    "filters": { "client_id": null, "limit": 10 },
    "grain": "Une facture du registre.",
    "freshness": { "generated_at": "…", "source": "live", "stale": false, "max_age_seconds": 0 },
    "catalog_version": "2026.07.26-1",
    "metrics": ["receivables.open.amount_ttc", "…"],
    "coverage": { "global_total_suppressed": false, "notes": [] },
    "anomalies": [{ "code": "…", "label": "…", "count": 3, "severity": "info", "hint": "…" }],
    "truncation": [{ "block": "top_overdue", "returned": 10, "total": 42 }],
    "permissions": { "reporting_read": true, "reporting_financial": true, "…": true },
    "disclaimer": "Indicateurs de pilotage commercial — ne remplacent pas les états comptables validés."
  },
  "data": { /* section */ },
  "comparison": { "net_ht": { "previous": 1200, "absolute": 200, "relative": 0.167 } },
  "deferred": [ /* métriques volontairement non publiées, avec ce qui bloque */ ]
}
```

`comparison.relative` vaut `null` quand la base est nulle ou négative : un pourcentage
n'existe pas dans ce cas, et l'inventer serait faux.

---

## 4. Périmètre des agrégats

### Registre des factures
Retenues : `ISSUED`, `PARTIALLY_PAID`, `PAID` + héritage `emise`, `emis`, `envoyee`,
`partielle`, `payee`.
Exclues **toujours** : `DRAFT`, `PENDING_VALIDATION`, `APPROVED`, `CANCELLED` + héritage
`brouillon`, `annulee`, `annule`.

`include_brouillon` (routes historiques) élargit aux pièces en **préparation** ; il ne fait
jamais entrer une pièce annulée.

### Avoirs
Seuls les avoirs **finalisés** (`ISSUED` + héritage `emis`, `emise`, `envoyee`) diminuent
le facturé.

### Règlements
Un règlement compte comme encaissement net s'il n'est ni rejeté (`REJECTED`), ni extourné
(`REVERSED` / `workflow_status = 'REVERSED'`), ni lui-même une contre-écriture
(`reversal_of_id IS NOT NULL`). Cette règle est neutre quelle que soit la convention
d'extourne retenue plus tard.

### Encours à `as_of` — la règle centrale
```
solde(facture) = total_ttc
               − Σ règlements imputés   (date_paiement ≤ as_of ET imputation créée ≤ as_of)
               − Σ avoirs finalisés imputés (registre ≤ as_of ET imputation créée ≤ as_of)
```
Le solde **n'est pas écrêté**. `solde > 0` → créance ouverte. `solde < 0` → trop-perçu,
isolé et exposé. Les allocations #227 et le rattachement direct hérité sont réunis **sans
double comptage** : la branche héritée n'est retenue que pour les pièces sans ligne
d'allocation.

### Livraisons et carnet
Un BL consomme la commande dès `SHIPPED` (aligné sur `v_bon_livraison_reliquats_226`),
mais **borné à `as_of`**, ce que la vue ne fait pas. Le carnet vaut
`GREATEST(quantité commandée − quantité expédiée, 0) × prix net de la ligne`.

---

## 5. Précision monétaire

Toutes les sommes sont faites en `NUMERIC(18,2)` et renvoyées en `text` par PostgreSQL.
La conversion en nombre a lieu une seule fois, à la frontière TypeScript (`money()`).
Aucun `float8` dans un agrégat monétaire.

---

## 6. Sécurité

- Refus par défaut à deux niveaux : la route exige la capacité minimale, le service
  re-vérifie la capacité exacte de chaque bloc.
- Aucune valeur de filtre n'est interpolée dans le SQL : tout passe en paramètre lié.
- Aucune réponse n'expose de coordonnée personnelle (e-mail, téléphone, adresse, contact,
  SIRET). Seuls l'identifiant client et la raison sociale circulent.
- Les exports portent une empreinte SHA-256 (`X-CERP-Export-Checksum`), l'auteur et
  l'horodatage.
- Une erreur de base ne renvoie jamais le SQL au client.

---

## 7. Base de données

`db/patches/20260726_reporting_commercial_360_275.sql` — **17 index, rien d'autre.**
Aucune table, colonne, contrainte ni donnée. Axes indexés : cohortes de devis
(`statut, date_creation`), prises de commande (`date_commande`), expéditions
(`statut, date_expedition`), registre des pièces (`statut, date_emission`), échéances,
encaissements et dates d'imputation.

Support : `.preflight.sql` (lecture seule), `.verify.sql` (17/17 + lisibilité `cerp_app`),
`.rollback.sql`, `.invariants.sql` (banc de réconciliation en transaction annulée).

---

## 8. Banc de réconciliation

`db/patches/support/20260726_reporting_commercial_360_275.invariants.sql` insère un jeu
d'essai, rejoue **les requêtes de production** (générées par
`src/__tests__/reporting-360-275.sql.test.ts`) contre un vrai PostgreSQL, puis **annule**
la transaction.

Attendus vérifiés le 26/07/2026 sur `cerp_test` :

| Invariant | Valeur |
|---|---|
| Encours à l'arrêté | 1 780,00 € (3 factures) |
| Échu | 1 180,00 € (2 factures) |
| Trop-perçu isolé | 50,00 € (1 facture) |
| Somme des tranches d'ancienneté | 600 + 480 + 700 = **1 780,00 €** = encours |
| Facturé net HT | 1 983,33 − 583,33 = **1 400,00 €** |
| Somme des clients | 1 000 + 400 = **1 400,00 €** = facturé net |
| Règlement du 01/08 et avoir du 01/09 | **sans effet** sur l'arrêté au 30/06 |
| Avoir imputé par lien direct **et** par allocation | compté **une seule fois** (200,00 €) |
| Règlements non affectés / avoirs non affectés | 250,00 € / 400,00 € |
| Facture annulée, facture en brouillon | hors registre, comptées à part |
| BL expédié après l'arrêté | hors carnet, dans la période |

Exécution :
```bash
# 1) régénérer les requêtes de production
npx vitest run src/__tests__/reporting-360-275.sql.test.ts
# 2) rejouer contre PostgreSQL (transaction annulée, aucune donnée conservée)
scp "$TMP/cerp-reporting-275-queries.sql" \
    db/patches/support/20260726_reporting_commercial_360_275.invariants.sql \
    keenan@192.168.1.244:/tmp/
ssh keenan@192.168.1.244 \
  "sudo -u postgres psql -d cerp_test -X -f /tmp/20260726_reporting_commercial_360_275.invariants.sql"
```

---

## 9. Limites assumées

- **Aucune date de décision de devis** : `devis_historique` et `devis_etat_suivi` existent
  mais ne sont écrits par aucun code. Les taux décrivent l'état **courant** d'une cohorte
  de création, pas un flux daté.
- **`commande_client` n'a aucun statut** : une commande annulée n'est pas distinguable.
- **`facture_echeance` n'est pas encore exploité** : une facture à échéances multiples est
  traitée comme mono-échéance (échéance d'en-tête).
- **Aucun modèle de périmètre client par utilisateur** n'existe dans le CERP : le
  cloisonnement repose sur les capacités, pas sur une appartenance commerciale.
- **Aucune table de taux de change datés** : tout total inter-devises est refusé.
