# Contrat HTTP — Commandes fournisseurs (#172, BCF)

Base : `/api/v1/commandes-fournisseurs` — derrière le socle default-deny
(`authenticateToken`) + gardes de capacité par route (refus par défaut). Zod strict :
tout champ inconnu est rejeté. Enveloppe d'erreur commune
`{ success:false, message, code, path, details? }` ; validation →
`400 { error:"VALIDATION_ERROR", errors:[{field,message}] }`. Corrélation `X-Request-Id`.
Idempotence : header `Idempotency-Key` (≥ 8 car.) ou champ body dédié.

Le `code` (`BCF-AAAA-NNNN`) est généré serveur (whitelist `fn_next_issued_code_value`),
immuable, jamais accepté du client. Les montants sont masqués (`null` +
`prices_masked:true`) pour les rôles sans capacité `prices`.

## Lecture

- `GET /` — capacité `read`. Query bornée : `q` (≤120), `statut` (enum, multiple),
  `fournisseur_id` (uuid), `origine` (enum), `en_retard` (`true|false`),
  `page` (≤10000), `page_size` (≤100), `sort`
  (`created_at|date_besoin|date_promesse|code|total_ttc|updated_at`), `dir`.
  → `{ items[], total, page, page_size }` (items : fournisseur mini, `en_retard`,
  `nb_lignes`, `qty_commandee`, `qty_recue`, totaux masquables).
- `GET /kpis` — `read`. → `{ brouillons, a_valider, a_envoyer, sans_accuse, en_retard, a_recevoir }`.
- `GET /:id` — `read`. Détail complet : en-tête, `allowed_transitions`, lignes (avec
  `qty_recue`/`qty_recue_nc` (lots BLOQUE/QUARANTAINE)/`qty_restante` **calculées**,
  besoins couverts), `transitions` (append-only), `documents` (métadonnées + SHA-256),
  `receptions` liées. 404 `COMMANDE_FOURNISSEUR_NOT_FOUND`.
- `GET /:id/documents/:documentId` — `read`. → `{ meta, payload }` (payload JSON canonique
  dont le SHA-256 est l'empreinte d'autorité). 404 `DOCUMENT_NOT_FOUND`.

## Écriture (brouillon)

- `POST /` — `create`. Body : `fournisseur_id` (uuid requis), `origine`, devise ISO,
  conditions, incoterm (enum), dates, commentaires public/interne, frais de port,
  `lignes[]` (≤200 ; type enum ; article/catalogue requis sauf LIBRE_CONTROLEE/PRESTATION ;
  quantité > 0 ; remise/TVA 0–100 ; conversion unité complète ou absente ; `besoins[]`
  optionnels). → `201 { id, code }` ; replay → `200 { …, idempotent_replay:true }` ;
  clé réutilisée sur autre action → 409 `IDEMPOTENCY_KEY_REUSED` ; fournisseur inactif →
  422 `FOURNISSEUR_INACTIF` ; besoin déjà couvert → 409 `BESOIN_DEJA_COUVERT`.
- `PATCH /:id` — `update_draft`. Tri-state (seules les clés présentes changent) +
  `expected_updated_at` (verrou → 409 `CONCURRENT_MODIFICATION`). Brouillon uniquement
  (422 `DRAFT_ONLY`). Totaux recalculés serveur. → 204.
- `POST /:id/lignes` / `PATCH /:id/lignes/:ligneId` / `DELETE /:id/lignes/:ligneId` /
  `POST /:id/lignes/reorder` — `update_draft`, brouillon uniquement, verrou en-tête,
  totaux recalculés ; reorder = permutation complète validée (422 `REORDER_MISMATCH`),
  position UNIQUE DEFERRABLE. Suppression physique en brouillon seulement (libère la
  couverture besoin).
- `POST /totaux/simulate` — `read`. Calcul pur serveur (arrondi half-away-from-zero,
  centimes exacts) : `{ total_ht, total_remise, total_tva, total_ttc, frais_port_ht }`.

## Cycle de vie

- `POST /:id/transition` — garde coarse (une capacité de transition au moins) + RBAC fin
  par nature dans le repository une fois l'état source verrouillé (`FOR UPDATE`).
  Body : `{ to, motif?, expected_updated_at?, idempotency_key? }`.
  - 422 `INVALID_TRANSITION` `{from,to,allowed}` ; 422 `MOTIF_REQUIS` (annulation, rejet,
    réédition, clôture avec reliquat) ; 422 `COMMANDE_SANS_LIGNE` ; 422
    `FOURNISSEUR_INACTIF` ; 422 `DOCUMENT_VERSION_REQUISE` (envoi sans version figée) ;
    422 `RECEPTION_DERIVED_STATUS` (`PARTIELLEMENT_RECUE`/`RECUE` manuels interdits) ;
    422 `ANNULATION_IMPOSSIBLE_RECEPTIONNEE` (quantités déjà reçues) ; 403
    `FORBIDDEN_TRANSITION` ; 409 verrou. État déjà atteint → `200 { statut,
    idempotent_replay:true }` (double-clic sûr).
  - Envoi (`APPROUVEE→ENVOYEE`) : fige `fournisseur_snapshot`/`conditions_snapshot`,
    `date_envoi`, `sent_by`, marque `sent_at` de la version documentaire courante.
    L'envoi est explicite et simulable : aucun email réel n'est émis par l'API.
- `POST /:id/accuse` — `acknowledge`. `{ reference_fournisseur (requis), date_accuse?,
  date_promesse?, expected_updated_at? }` ; exige `ENVOYEE`. → `{ statut:"ACCUSE_RECU" }`.
- `POST /:id/documents` — `send`. Exige `APPROUVEE` ; v≥2 exige `motif_revision`.
  Fige le payload JSON canonique + SHA-256. → 201 métadonnées.
- `POST /:id/receptions/resync` — `read` (recalcul idempotent de l'état de réception ;
  la sur-réception n'est tolérée que si le rôle porte `over_receipt`).
- `POST /:id/duplicate` — `create`. Nouveau brouillon, nouveau code, lignes ACTIVE
  copiées SANS les liens besoins.

## Propositions d'achat

- `POST /propositions/preview` — `create`. `{ origines:["SEUIL_STOCK"|"RUPTURE_OF"],
  of_ids?, fournisseur_id?, limit≤200 }`. **Lecture seule.** Sélectionne les besoins
  éligibles NON couverts (index unique de couverture), explique fournisseur proposé
  (stock_levels.supplier_id sinon meilleur catalogue actif), prix (+source
  CATALOGUE_FOURNISSEUR/NOMENCLATURE_ACHAT), délai, alertes (`MOQ_APPLIQUE`,
  `PRIX_MANQUANT`), groupe par fournisseur+devise, liste les bloqués
  (`AUCUN_FOURNISSEUR`, `FOURNISSEUR_INACTIF`).
- `POST /propositions/confirm` — `create`. `{ idempotency_key (requis), groupes[] }` →
  `201 { commandes:[{id,code,fournisseur_id}] }`. Transactionnel, crée des **BROUILLONS**
  uniquement (jamais soumis/approuvés/envoyés) ; course sur un besoin → 409
  `BESOIN_DEJA_COUVERT` ; replay → mêmes commandes + `idempotent_replay:true`.

## Intégration réceptions (module `receptions`, additif)

`POST /receptions` accepte `commande_fournisseur_id` (même fournisseur, commande
ENVOYEE/ACCUSE_RECU/PARTIELLEMENT_RECUE — sinon 422) ; `POST /receptions/:id/lines`
accepte `commande_fournisseur_ligne_id` (cohérence fournisseur/article/état vérifiée :
422 `ARTICLE_MISMATCH`, `LIGNE_COMMANDE_ANNULEE`, `COMMANDE_FOURNISSEUR_NON_RECEVABLE`),
puis recalcule transactionnellement l'état de la commande (sur-réception → 422
`OVER_RECEIPT` sauf rôle `over_receipt` + notes ≥ 3 car.).

## Audit & événements

Chaque écriture journalise `erp_audit_logs` (action `commandes_fournisseurs.*`, acteur,
entité, détails non sensibles, corrélation) dans la transaction métier ; l'historique des
transitions est append-only (FK RESTRICT : l'en-tête ne peut pas être supprimé).
