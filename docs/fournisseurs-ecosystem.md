# Fournisseurs Ecosystem — Backend Notes (#163 Fournisseur 360)

## Purpose

The Fournisseurs module is the **authoritative supplier reference** and the source of
truth for purchasing. It supports a generic, multi-domain supplier model while preserving
the legacy outillage supplier tables and their numeric identifiers.

## Source of truth (canonical)

- `public.fournisseurs` — **canonical UUID supplier record**. Extended with `status`,
  `type_principal`, address cache (`adresse_ligne`, `house_no`, `postcode`, `city`,
  `country`), `nom_commercial`, `logo`, `archived_at`. Visible business code lives in
  `code`/`code_fournisseur` (see *Codification* below).
- `public.fournisseur_contacts` — contacts (one primary per supplier, enforced by a
  partial unique index).
- `public.fournisseur_adresses` *(#163)* — **typed addresses** (`commande` / `livraison`
  / `facturation`), one primary per (supplier, type). The flat address columns on
  `fournisseurs` are a service-maintained **read-cache** of the primary `commande`
  address — a single write path, never divergently written by clients.
- `public.fournisseur_domaines` — active domain dictionary; `public.fournisseur_domaine_lien`
  — many-to-many supplier↔domain link with a single primary domain per supplier.
- `public.fournisseur_homologations` *(#163)* — **structured qualification/homologation**:
  status (`a_qualifier`/`en_cours`/`homologue`/`sous_reserve`/`suspendu`/`refuse`/`expire`),
  optional domain scope, validity window, optional certificate document, **versioned**
  (`version`, one `is_current` per supplier/domain scope).
- `public.fournisseur_catalogue` — supplier catalogue (authoritative reference/price/lead
  time). *(#163)* enriched with `incoterm`, `prix_multiple`, price validity
  (`valid_from`/`valid_to`), `exigence_qualite`, `requiert_controle_reception`, and an
  optional FK `devise → currencies(code)`.
- `public.fournisseur_catalogue_prix_history` *(#163)* — price/lead-time history, appended
  on price-affecting changes.
- `public.fournisseur_documents` — private documents (SHA-256, soft-delete). `storage_path`
  and `stored_name` are **internal** and never leave the API (DTO minimization).
- `public.fournisseur_events` — supplier activity stream (now written on create/deactivate/
  archive/homologation).
- `public.fournisseur_outillage_mapping` — bridge from `public.fournisseurs.id` to
  `public.gestion_outils_fournisseur.id_fournisseur`. Read at runtime to populate
  `relations.outillage` (counts of tools/manufacturers/prices/movements).

## Outillage compatibility (unchanged)

`gestion_outils_fournisseur`, `*_fabricant`, `*_outil_fournisseur`, `*_historique_prix`,
and `*_mouvement_stock` remain unchanged. The bridge maps generic UUID suppliers to legacy
numeric outillage suppliers **without rewriting** tool/manufacturer/price/stock history.
There is **no third master table** and **no duplicate supplier** for outillage.

## Invariants

- **Codification**: the visible supplier code is generated **server-side, in the creation
  transaction**, via `public.fn_next_issued_code_value('FOU')` → `FOU-NNN`. It is
  **immutable** (removed from the create body and never updated). No frontend allocation,
  no `MAX + 1`.
- **UUID/FK internes**: relations use PK/UUID/FK, never code/name.
- **SIRET/TVA**: normalized (upper, alphanumeric) partial-unique indexes on
  `fournisseurs`; legacy-safe (falls back to non-unique when duplicates already exist). A
  protected `GET /fournisseurs/doublons` endpoint returns a minimal projection.
- **Primary contact/address**: exactly one primary (per type for addresses), toggled
  transactionally.
- **Optimistic concurrency**: `PATCH /fournisseurs/:id` accepts `expected_updated_at`
  and returns **409** on a stale write.
- **Archiving** (`POST /:id/archive`) is distinct from deactivation; physical deletion is
  never performed.
- **Audit**: every mutation writes to the append-only `public.erp_audit_logs` inside the
  same transaction (actor/action/entity/path/details).

## RBAC (capability tiers)

Reads are open to any authenticated internal user. Writes/sensitive actions are role-gated
(`authorizeRole`, exact match, deny-by-default):

| Capability | Roles |
|---|---|
| Create/edit fournisseur, contacts, adresses, catalogue, documents, doublon | Directeur, Administrateur Systeme et Reseau, Secretaire, Responsable Programmation, Responsable Qualité |
| Homologation, deactivate/blocage | Directeur, Administrateur Systeme et Reseau, Responsable Qualité |
| Archive, export | Directeur, Administrateur Systeme et Reseau |

## API surface (`/api/v1/fournisseurs`)

- `GET /`, `GET /doublons`, `GET /domaines`, `GET /:id`, `GET /:id/events`
- `POST /`, `PATCH /:id`, `POST /:id/deactivate`, `POST /:id/archive`, `PUT /:id/domaines`
- Contacts: `GET/POST /:id/contacts`, `PATCH/DELETE /:id/contacts/:contactId`
- Adresses: `GET/POST /:id/adresses`, `PATCH/DELETE /:id/adresses/:adresseId`
- Homologations: `GET/POST /:id/homologations`, `PATCH /:id/homologations/:homologationId`
- Catalogue: `GET/POST /:id/catalogue`, `PATCH/DELETE /:id/catalogue/:catalogueId`
- Documents: `GET/POST /:id/documents`, `DELETE /:id/documents/:docId`, `GET …/download`

## Schema materialization note (2026-07-21)

On 2026-07-21 the live databases (`cerp_test` and `cerp_prod`) were found to have the
ecosystem patch `20260616_fournisseurs_ecosystem.sql` **recorded as applied but never
executed** (baselined onto an older "French" schema). It was materialized (idempotent,
empty tables) and the additive `20260721_fournisseurs_360.sql` applied, on both databases,
with backups and read-only preflight/verify. Both databases are now aligned with the repo.
Support scripts: `db/patches/support/20260721_fournisseurs_360.{preflight,verify,rollback}.sql`.
