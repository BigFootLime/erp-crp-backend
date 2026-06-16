# Fournisseurs Ecosystem Backend Notes

## Purpose

The Fournisseurs module now supports a generic multi-domain supplier model while preserving the existing outillage supplier tables and numeric identifiers.

## Tables

- `public.fournisseurs`: generic UUID supplier record, extended with status, primary domain, address, commercial name, logo, and archive timestamp.
- `public.fournisseur_domaines`: active supplier domain dictionary.
- `public.fournisseur_domaine_lien`: many-to-many supplier/domain link with one primary domain per supplier.
- `public.fournisseur_events`: supplier activity stream.
- `public.fournisseur_outillage_mapping`: bridge from `public.fournisseurs.id` to `public.gestion_outils_fournisseur.id_fournisseur`.

## Outillage Compatibility

`gestion_outils_fournisseur`, `gestion_outils_fournisseur_fabricant`, `gestion_outils_outil_fournisseur`, `gestion_outils_historique_prix`, and `gestion_outils_mouvement_stock` remain unchanged. The migration adds the bridge table needed to map generic UUID suppliers to legacy numeric outillage suppliers without rewriting tool, manufacturer, price, or stock history.

## API Additions

- `GET /api/v1/fournisseurs/domaines`
- `PUT /api/v1/fournisseurs/:id/domaines`
- `GET /api/v1/fournisseurs/:id/events`

Existing supplier create/update endpoints accept richer identity fields and optional domain links. List/detail responses remain backward compatible and expose defaults for the new frontend fields until the bridge/data-enrichment work is filled in further.
