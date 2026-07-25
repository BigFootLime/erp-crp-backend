# Métrologie 360 (#229) — modèle, API, états et impacts

Surface : `/api/v1/metrologie/v2`. Le routeur historique `/api/v1/metrologie`
reste en place, chemins et contrats inchangés ; il gagne seulement les mêmes
gardes RBAC.

Patch : `db/patches/20260726_metrologie_360_229.sql`
Rollback : `db/patches/support/20260726_metrologie_360_229.rollback.sql`
(restreint à `cerp_test`, refuse de s'exécuter dès qu'une preuve existe).

---

## 1. Vocabulaire — ce qui n'est pas interchangeable

| Terme | Ce que c'est | Ce que ce n'est pas |
| --- | --- | --- |
| **Plan métrologique** | Règle versionnée : périodicité, méthode, tolérances, responsable, échéance | Une date saisie à la main |
| **Étalonnage** | Comparaison à un étalon/référence, avec résultat et certificat | Une vérification interne |
| **Vérification interne** | Contrôle d'aptitude périodique défini par procédure, tracé par un PV | Un certificat externe |
| **Ajustage / réparation** | Intervention technique, exige une requalification avant remise en service | Une preuve d'aptitude |
| **Contrôle qualité produit** | Exécution sur pièce/lot/OF qui *référence* l'instrument utilisé | L'historique métrologique de l'instrument |

---

## 2. Flux cible

```
Référentiel équipement
      │
      ▼
Qualification + spécifications structurées (unité, plage, résolution, EMT, incertitude, méthodes)
      │
      ▼
Plan versionné (DRAFT → ACTIVE → ARCHIVED)   ── publier archive la version précédente
      │
      ▼
Exécution : ETALONNAGE | VERIFICATION | AJUSTAGE | REPARATION
      │
      ▼
Mesures → verdict CALCULÉ → aperçu serveur (empreinte) → verdict RETENU + décision
      │
      ├── CONFORME / CONFORME_AVEC_RESTRICTION ──► dernière preuve + prochaine échéance
      │
      └── NON_CONFORME ──► quarantaine ciblée + analyse d'impact BORNÉE
                                   │
                                   ▼
                    contrôles → OF / lots / BL  (liste explicable, paginée)
                                   │
                                   ▼
                      décisions HUMAINES motivées, définitives
```

---

## 3. Modèle de données

### Tables créées

| Table | Rôle |
| --- | --- |
| `metrologie_categories` | Référentiel administré des catégories de moyens de mesure. Désactivation, jamais suppression, quand elle est utilisée. Porte les exigences de saisie (`requires_range`, `requires_unit`, …). |
| `metrologie_plan_version` | Règle versionnée par équipement et par type d'opération. Une seule version `ACTIVE` par couple (index unique partiel). |
| `metrologie_execution` | Étalonnage, vérification, ajustage ou réparation. Immuable une fois validée, jamais supprimable. |
| `metrologie_execution_measurement` | Points de mesure, avec verdict et écart calculés serveur. |
| `metrologie_measurement_revision` | Historique append-only des corrections de relevé (motif obligatoire). |
| `metrologie_impact_dossier` | Analyse d'impact bornée : fenêtre, méthode, exclusions, volumes, troncature. |
| `metrologie_impact_item` | Un usage de l'instrument (contrôle, OF, lot, BL) et sa décision. |
| `metrologie_command_receipts` | Reçus d'idempotence (acteur + clé unique). |

### Tables étendues (additif)

- `metrologie_equipements` : `categorie_code`, `etat`, spécifications structurées
  (`unite`, `plage_min/max`, `resolution`, `mpe`, `incertitude`, `methodes[]`,
  `restrictions`, `etalon_reference`, `exige_certificat`), implantation
  (`site`, `magasin`, `zone`, `localisation_precise`), responsabilité,
  quarantaine et dernière preuve conforme.
- `metrologie_certificats` : `execution_id`, `document_kind`, `emetteur`,
  `numero_externe`, `couverture`, `statut`, `confidentiality`, chaînage
  `replaced_by_id`.
- `metrologie_event_log` : `entity_type`, `entity_id`, `correlation_id`,
  `idempotency_key`, `rule_code`, `reason`, `request_id`, `source`.

### États

**Stockés** (gouvernance) : `DRAFT`, `ACTIVE`, `QUALIFIED`, `SUSPENDED`,
`QUARANTINE`, `OUT_OF_TOLERANCE`, `UNDER_REPAIR`, `RETIRED`.

**Dérivés** (jamais stockés) : `DUE_SOON`, `OVERDUE`. Ils sont recalculés à
chaque lecture depuis le plan actif et la date du jour, pour ne jamais dériver
de la réalité. L'API expose `etat` (stocké) **et** `etat_effectif` (affiché).

`statut` (`ACTIF/INACTIF/REBUT`) reste la vue héritée, synchronisée dans les
deux sens par trigger. Une remise à `ACTIF` par le routeur historique ne fait
**pas** sortir un instrument de quarantaine.

Transitions autorisées :

```
DRAFT            → ACTIVE, QUALIFIED, RETIRED
ACTIVE           → QUALIFIED, SUSPENDED, QUARANTINE, OUT_OF_TOLERANCE, UNDER_REPAIR, RETIRED
QUALIFIED        → ACTIVE, SUSPENDED, QUARANTINE, OUT_OF_TOLERANCE, UNDER_REPAIR, RETIRED
SUSPENDED        → ACTIVE, QUALIFIED, QUARANTINE, UNDER_REPAIR, RETIRED
QUARANTINE       → UNDER_REPAIR, OUT_OF_TOLERANCE, QUALIFIED, RETIRED
OUT_OF_TOLERANCE → UNDER_REPAIR, QUARANTINE, QUALIFIED, RETIRED
UNDER_REPAIR     → QUARANTINE, QUALIFIED, RETIRED
RETIRED          → (aucune)
```

Tout retour vers `ACTIVE`/`QUALIFIED` depuis `QUARANTINE`, `OUT_OF_TOLERANCE` ou
`UNDER_REPAIR` est une **libération** : capacité `equipment_release`, réparation
faite quand elle était exigée, preuve conforme valide et motif écrit.

### Codification

Allouée par le serveur dans la transaction, immuable ensuite (trigger).

| Objet | Format | Périmètre |
| --- | --- | --- |
| Équipement | `MET-000001` | `MET` |
| Exécution | `MEX-2026-000001` | `MEX:AAAA` |
| Dossier d'impact | `MIA-2026-00001` | `MIA:AAAA` |

Le patch restaure aussi `MCH` (parc machines #165), retiré par erreur lors de la
réécriture du garde par `20260725_qualite_360_228.sql`.

---

## 4. Éligibilité — la règle vit à un seul endroit

`src/module/metrologie/domain/metrology-eligibility.ts`. Le module Qualité la
**consomme**, il ne la ré-implémente pas.

Codes bloquants : `INSTRUMENT_REQUIRED`, `INSTRUMENT_UNKNOWN`,
`INSTRUMENT_DELETED`, `INSTRUMENT_RETIRED`, `INSTRUMENT_QUARANTINE`,
`INSTRUMENT_OUT_OF_TOLERANCE`, `INSTRUMENT_UNDER_REPAIR`,
`INSTRUMENT_NOT_QUALIFIED`, `INSTRUMENT_OUT_OF_SCOPE`,
`INSTRUMENT_METHOD_MISMATCH`, `INSTRUMENT_UNIT_MISMATCH`,
`INSTRUMENT_RANGE_MISMATCH`, `INSTRUMENT_CERTIFICATE_MISSING`,
`INSTRUMENT_OVERDUE_CRITICAL`, `OPERATOR_NOT_ALLOWED`.

Codes d'avertissement (n'interdisent pas) : `INSTRUMENT_DUE_SOON`,
`INSTRUMENT_OVERDUE`, `INSTRUMENT_UNIT_UNKNOWN`,
`INSTRUMENT_RESOLUTION_INSUFFICIENT`, `INSTRUMENT_UNCERTAINTY_EXCESSIVE`,
`INSTRUMENT_RESTRICTED`.

Notes :

- les unités sont normalisées par dimension (longueur, masse, température,
  pression, angle, force, temps) ; comparer deux dimensions différentes est un
  refus explicite, jamais une conversion « au mieux » ;
- l'aptitude suit les règles d'atelier 1/10 (résolution) et 1/3 (incertitude)
  face à l'intervalle de tolérance : c'est un **avertissement**, pas une
  interdiction réglementaire ;
- le blocage à échéance dépassée vient de `blocking_strategy` du plan
  applicable (`BLOCK` / `WARN` / `NONE`) ou du réglage
  `metrologie.block_on_overdue_critical` restreint aux instruments **critiques
  et échus**. Sa portée est écrite en base (`scope = PER_INSTRUMENT`).

---

## 5. Endpoints

Toutes les commandes à effet exigent `Idempotency-Key` ; toutes les
modifications d'un agrégat existant exigent `expected_updated_at`.

### Référentiels

| Méthode | Chemin | Capacité |
| --- | --- | --- |
| `GET` | `/categories` | `read` |
| `PUT` | `/categories` | `categories_manage` |
| `GET` | `/units` | `read` |

### Command center et éligibilité

| Méthode | Chemin | Capacité |
| --- | --- | --- |
| `GET` | `/center` | `read` |
| `GET` | `/eligibility?mode=single\|candidates` | `read` |

### Registre

| Méthode | Chemin | Capacité |
| --- | --- | --- |
| `GET` | `/equipements` | `read` |
| `POST` | `/equipements` | `equipment_write` |
| `GET` | `/equipements/:id` | `read` |
| `PATCH` | `/equipements/:id` | `equipment_write` |
| `POST` | `/equipements/:id/quarantine` | `quarantine_set` |
| `POST` | `/equipements/:id/transitions` | `repair_manage` (+ `equipment_release` sur libération) |
| `GET` | `/equipements/:id/timeline` | `audit_read` |
| `GET` | `/equipements/:id/usage` | `impact_read` |

`POST /equipements` **refuse** un champ `code` : il est alloué par le serveur.

### Plans

| Méthode | Chemin | Capacité |
| --- | --- | --- |
| `GET` | `/equipements/:id/schedule-preview` | `read` |
| `POST` | `/equipements/:id/plans` | `plan_manage` |
| `POST` | `/equipements/:id/plans/:childId/revisions` | `plan_manage` |
| `POST` | `/equipements/:id/plans/:childId/transitions` | `plan_manage` |

### Exécutions

| Méthode | Chemin | Capacité |
| --- | --- | --- |
| `GET` | `/executions`, `/executions/:id` | `read` |
| `POST` | `/equipements/:id/executions` | `execution_record` |
| `POST` | `/executions/:id/measurements` | `execution_record` |
| `GET` | `/executions/:id/verdict-preview` | `read` |
| `POST` | `/executions/:id/validate` | `verdict_validate` |
| `POST` | `/executions/:id/cancel` | `execution_record` |

`validate` exige le `preview_hash` de l'aperçu : une saisie modifiée entre
l'aperçu et la confirmation renvoie `409 METROLOGY_PREVIEW_STALE`.

### Certificats et PV

| Méthode | Chemin | Capacité |
| --- | --- | --- |
| `POST` | `/equipements/:id/certificats` (multipart, champ `document`) | `documents_write` |
| `POST` | `/equipements/:id/certificats/:childId/cancel` | `documents_write` |
| `GET` | `/equipements/:id/certificats/:childId/file` | `documents_read` |

Contrôles : extension, MIME, **signature réelle** (magic bytes), taille ≤ 25 Mo,
SHA-256. `storage_path` ne sort jamais d'un DTO, d'un log ni d'une URL.

### Analyse d'impact

| Méthode | Chemin | Capacité |
| --- | --- | --- |
| `GET` | `/impacts`, `/impacts/:id` | `impact_read` |
| `POST` | `/equipements/:id/impacts` | `impact_create` |
| `POST` | `/impacts/:id/items/:childId/decision` | `impact_decide` |
| `POST` | `/impacts/:id/transitions` | `impact_decide` |

---

## 6. Matrice des permissions

Refus par défaut. Les rôles CERP sont du texte libre : la correspondance se fait
par sous-chaîne, comme pour `quality-policy.ts`.

| Capacité | Admin / Direction | Métrologie | Qualité / QSE | Méthodes | Production / Atelier | Magasin, ADV, Finance |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| `read` | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `categories_manage` | ✓ | ✓ | ✓ | — | — | — |
| `equipment_write` | ✓ | ✓ | ✓ | ✓ | — | — |
| `plan_manage` | ✓ | ✓ | ✓ | — | — | — |
| `execution_record` | ✓ | ✓ | ✓ | — | ✓ | — |
| `verdict_validate` | ✓ | ✓ | ✓ | — | — | — |
| `documents_read` | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `documents_write` | ✓ | ✓ | ✓ | — | — | — |
| `quarantine_set` | ✓ | ✓ | ✓ | — | ✓ | — |
| `repair_manage` | ✓ | ✓ | ✓ | ✓ | — | — |
| `equipment_release` | ✓ | ✓ | ✓ | — | — | — |
| `impact_read` | ✓ | ✓ | ✓ | ✓ | — | — |
| `impact_create` | ✓ | ✓ | ✓ | — | — | — |
| `impact_decide` | ✓ | — | ✓ | — | — | — |
| `settings_manage` | ✓ | — | — | — | — | — |

Lectures utiles :

- l'atelier **alerte** (quarantaine) et **relève** (mesures), il ne conclut pas
  et ne libère pas ;
- la **décision d'impact** appartient à la Qualité et à la direction, pas à la
  métrologie qui a constaté le défaut ;
- **séparation des tâches** : l'opérateur d'une vérification interne ne valide
  pas son propre verdict, et l'auteur d'une intervention ne prononce pas sa
  propre remise en service.

---

## 7. Ce que le module ne fait JAMAIS

L'analyse d'impact est une **liste explicable**, pas un moteur d'action. Elle
n'annule aucun contrôle, ne déstocke aucun lot, n'annule aucun bon de livraison,
ne crée aucun avoir, ne bloque aucune expédition et ne déclenche aucun rappel
client. Chaque décision (`RECHECK`, `HOLD_LOT`, `OPEN_NC`, `REISSUE_DOCUMENT`,
`INFORM_CUSTOMER`) est **tracée ici** et **exécutée dans le module concerné**,
par un humain habilité, avec motif.

Le journal l'écrit noir sur blanc : `automatic_actions: "none"` sur l'ouverture
du dossier, `executed_by_this_module: false` sur chaque décision.

---

## 8. Erreurs

| Statut | Codes |
| --- | --- |
| `400` | `IDEMPOTENCY_KEY_INVALID`, `INVALID_STORAGE_PATH` |
| `401` | `UNAUTHORIZED` |
| `403` | `METROLOGY_CAPABILITY_REQUIRED`, `METROLOGY_SEPARATION_OF_DUTIES` |
| `404` | `NOT_FOUND` |
| `409` | `METROLOGY_VERSION_CONFLICT`, `METROLOGY_PREVIEW_STALE`, `IDEMPOTENCY_KEY_REUSED`, `METROLOGY_*_TRANSITION_FORBIDDEN`, `METROLOGY_EXECUTION_IMMUTABLE`, `METROLOGY_IMPACT_ALREADY_DECIDED`, `METROLOGY_CODE_DUPLICATE` |
| `413` | `METROLOGY_DOCUMENT_TOO_LARGE` |
| `422` | `METROLOGY_VALIDATION_ERROR` (avec `details.fields`), `METROLOGY_SPECIFICATIONS_INCOMPLETE`, `METROLOGY_CERTIFICATE_REQUIRED`, `METROLOGY_RELEASE_INCOMPLETE`, `METROLOGY_IMPACT_WINDOW_TOO_WIDE`, `METROLOGY_DOCUMENT_SIGNATURE_REJECTED` |

Aucune trace SQL ni pile d'appel ne remonte au client.

---

## 9. Tests

- `src/__tests__/metrologie-360-229.domain.test.ts` — 82 cas : RBAC, machine à
  états, échéances (dont bornage du quantième), unités et conversions,
  éligibilité (matrice complète), snapshot, verdicts, fenêtre d'impact,
  idempotence et verrou optimiste.
- `src/__tests__/metrologie-360-229.routes.test.ts` — 32 cas : RBAC refusé par
  défaut, validation stricte, non-fuite de `storage_path`, éligibilité.
