# ADR-0089 — Parent authorization for private GED and operational media

## Status

Accepted — issue #615.

## Decision

Possession of a GED version UUID or operational-media UUID is never an
authorization grant. Before private bytes are opened, the delivery boundary
must resolve exactly one current, supported business parent and apply that
parent module's access profile. An absent, unsupported, malformed, stale,
ambiguous, or inaccessible binding receives the same opaque `404` response.

GED document-link aliases are accepted only through this closed map:

| Link type(s) | Canonical parent | Module | Parent identity |
| --- | --- | --- | --- |
| `CLIENT` | `CLIENT` | `clients` | text |
| `FOURNISSEUR` | `FOURNISSEUR` | `fournisseurs` | UUID |
| `DEVIS` | `DEVIS` | `devis` | integer |
| `FACTURE`, `AVOIR` | same | `facturation` | integer |
| `BON_LIVRAISON`, `LIVRAISON` | `BON_LIVRAISON` | `livraisons` | UUID |
| `COMMANDE_CLIENT`, `COMMANDE-CLIENT` | `COMMANDE_CLIENT` | `commandes-clients` | integer |
| `COMMANDE_FOURNISSEUR`, `COMMANDE-FOURNISSEUR` | `COMMANDE_FOURNISSEUR` | `commandes-fournisseurs` | UUID |
| `AFFAIRE` | `AFFAIRE` | `affaires` | integer |
| `ORDRE_FABRICATION`, `ORDRE-FABRICATION`, `OF` | `ORDRE_FABRICATION` | `production` | integer |
| `PIECE_TECHNIQUE`, `PIECE-TECHNIQUE`, `PIECE_TECHNIQUE_VERSION` | same | `pieces-techniques` | UUID |
| `STOCK_ARTICLE`, `STOCK-ARTICLE` | `STOCK_ARTICLE` | `stock` | UUID |
| `OUTIL` | `OUTIL` | `outillage` | integer |

Operational media uses a separate closed owner map: machine → production,
client → clients, fournisseur → fournisseurs, tooling owners → outillage, and
an active user avatar → chat. It also requires one binding, a live owner, and
the correct binding module; reused assets are denied rather than selecting a
visible owner.

Both transports persist an append-only authorization receipt before any
response byte. A failure to persist it fails closed. The post-finish completion
event records a completed transfer only after the sender reports completion;
an aborted or integrity-failed transfer is never reported as a download.

## Consequences

- Historical link vocabulary is not a compatibility bypass: it remains
  unavailable until explicitly added to the reviewed map with a parent query
  and module policy.
- Parent existence is revalidated at each request. This narrows stale links
  and prevents guessed UUIDs from being used as direct-object references.
- The check happens before the storage key is resolved and private download
  headers remain `private, no-store`, `nosniff`, and same-origin.
- Authorization is module-scoped because the current access-control model is
  module-scoped. A future per-record or tenant policy must replace (not weaken)
  this boundary and preserve opaque denials.
