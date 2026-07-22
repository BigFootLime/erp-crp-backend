# Devis — workflow durci (#167)

Référence : issue crp-systems-web#167. Périmètre : `src/module/devis/**`, patch
`db/patches/20260722_devis_workflow_167.sql`. Aucun nouveau module ; le contrat
existant est préservé (champs additifs uniquement).

## 1. Automate de statuts (appliqué au write-path)

Enum canonique inchangé : `BROUILLON, ENVOYE, ACCEPTE, REFUSE, EXPIRE, ANNULE`
(`src/module/devis/lib/status.ts`). Nouveauté #167 : les transitions sont désormais
**appliquées** par `repoUpdateDevis` (elles n'étaient que définies) :

```
BROUILLON → ENVOYE | ANNULE
ENVOYE    → ACCEPTE | REFUSE | EXPIRE | ANNULE
ACCEPTE   → ANNULE
REFUSE    → BROUILLON | ANNULE
EXPIRE    → BROUILLON | ENVOYE | ANNULE
ANNULE    → (terminal)
```

- Transition interdite → **409 `DEVIS_INVALID_TRANSITION`** (details: from/to/allowed).
- `GET /devis/:id` expose `allowed_statut_transitions` : l'UI reflète l'automate,
  elle ne le décide jamais.
- Naissance contrôlée : un devis (création) ou une révision ne naît qu'en
  `BROUILLON` ou `ENVOYE` — sinon **422 `DEVIS_INITIAL_STATUT_INVALID`** /
  **422 `DEVIS_REVISION_STATUT_INVALID`**. Les issues commerciales passent par les
  transitions (PATCH statut seul).

## 2. Immutabilité des versions

- Devis **engagé** (statut ≠ BROUILLON) : toute modification de contenu en place →
  **409 `DEVIS_ENGAGED_IMMUTABLE`** ; seule la transition de statut est permise.
  La modification passe par `POST /devis/:id/revise` (nouvelle version).
- Version **remplacée** (a une révision enfant) : totalement immuable →
  **409 `DEVIS_VERSION_SUPERSEDED`** ; `has_children` est exposé au GET.
- `numero` : immuable serveur (inchangé, 409 `DEVIS_CODE_IMMUTABLE`).
- Suppression protégée : converti → **409 `DEVIS_CONVERTED_UNDELETABLE`** ;
  a des révisions → **409 `DEVIS_HAS_REVISIONS`** ; engagé (ENVOYE/ACCEPTE) →
  **409 `DEVIS_ENGAGED_UNDELETABLE`**.

## 3. Verrou optimiste

`PATCH /devis/:id`, `POST /devis/:id/revise` et `POST /devis/:id/convert-to-commande`
acceptent `expected_updated_at` (jeton lu au GET, formats texte/JSONB tolérés).
Divergence → **409 `DEVIS_STALE`** (écritures) / **409 `DEVIS_DRAFT_STALE`**
(conversion, même code que le parcours préparé). Jamais d'écrasement silencieux.
Champ ADDITIF : un client qui ne l'envoie pas garde le comportement historique.

## 4. Idempotence (en-tête `Idempotency-Key`)

Pattern #172 enrichi d'une empreinte de payload — table `public.devis_idempotence`
(cle PK, action CHECK CREATE/REVISE/CONVERT, devis_id FK, payload_hash, resultat) :

- même clé + même action + même payload → **rejeu 200** du résultat enregistré
  (`idempotent_replay: true`), zéro double insertion ;
- même clé + autre action → **409 `IDEMPOTENCY_KEY_REUSED`** ;
- même clé + payload différent → **409 `IDEMPOTENCY_PAYLOAD_MISMATCH`** ;
- course concurrente (PK) → le perdant rejoue le résultat du gagnant.

Sur `POST /devis` (création), `POST /devis/:id/revise` et
`POST /devis/:id/convert-to-commande`. Table absente (pré-patch) → comportement
historique (dégradation douce).

## 5. Conversion contrôlée devis → commande

`POST /devis/:id/convert-to-commande` accepte un corps JSON optionnel
`{ "expected_updated_at": "…" }` + `Idempotency-Key`, et **délègue la création au
moteur unique `repoCreateCommande`** (module commande-client) — celui du parcours
« Préparer commande ». Conséquences (corrige la divergence historique des deux voies) :

- fraîcheur vérifiée ATOMIQUEMENT dans la transaction du moteur ;
- **officialisation des entités préparatoires** (`article_devis` /
  `dossier_technique_piece_devis` → articles/pièces officiels, promotions
  idempotentes ON CONFLICT) — annoncée dans l'aperçu frontend avant confirmation ;
- échéances, snapshot d'en-tête, lien source (`devis_id` UNIQUE,
  `source_devis_version_id`), **checkpoints de workflow commande initialisés**
  (la voie directe ne les créait pas) ;
- l'orchestrateur devis n'ouvre pas de transaction propre (un FOR UPDATE
  bloquerait le FK KEY SHARE du moteur) ; l'unicité `commande_client_devis_id_key`
  absorbe les courses.

Réponses :
- **201** `{ id, numero, devis_id, already_converted:false, idempotent_replay:false }` ;
- **200** avec `already_converted:true` si une commande existe déjà (elle est
  RETOURNÉE, jamais dupliquée — deux clics/deux onglets → même commande) ;
- **200** `idempotent_replay:true` sur rejeu de clé ;
- 400 `DEVIS_NOT_ACCEPTED` / `DEVIS_EMPTY`, 409 `DEVIS_DRAFT_STALE`.

La conversion NE lance PAS la fabrication : ni affaire, ni OF, ni BL, ni facture
(ADR-0016 commande pivot — ces étapes appartiennent au lancement de commande).
`GET /devis/:id` expose `converted_commande {id, numero}`.

## 6. Historique des versions

`GET /devis/:id/versions` (lecture) : lignée complète de la racine —
`{ items: [{ id, numero, version_number, parent_devis_id, statut, dates, totaux,
is_current, is_latest, has_commande, commande_id, commande_numero }], total }`.

## 7. RBAC par capacité (refus par défaut)

`src/module/devis/domain/devis-rbac.ts` (pattern #172, rôles par sous-chaîne,
aucun rôle inventé). Gardes de route + capacité fine re-vérifiée dans le repo
pour les transitions (`403 FORBIDDEN_TRANSITION`).

| Capacité | Rôles (needles) |
|---|---|
| read | admin, administrateur, directeur, secr(et), commercial, compt, program, planif, qualit, chargé d'affaires |
| create / update_draft / submit / revise / convert | admin, administrateur, directeur, secr(et), commercial |
| decide (accepter/refuser/expirer) | admin, administrateur, directeur, commercial |
| cancel / delete | admin, administrateur, directeur |
| export (PDF/documents) | admin, administrateur, directeur, secr(et), commercial, compt |

⚠️ Changement de comportement : les rôles hors matrice (ex. `Employee`) perdent la
lecture des devis (prix = donnée sensible, aligné sur #172). À valider en revue.

## 8. Position des lignes & totaux

- `devis_ligne.position` (patch 20260722, backfill par id) : l'ordre du payload est
  persisté à la création/révision, cloné en révision, respecté à la conversion et
  exposé au GET (tri `position NULLS LAST, id`).
- Totaux de LIGNE (`total_ht`/`total_ttc`) désormais recalculés et persistés
  serveur à l'insertion ; totaux d'en-tête recalculés aussi sur PATCH
  (les totaux client sont ignorés — CA-APP-01).

## 9. Audit transactionnel

`erp_audit_logs` via `repoInsertAuditLog(tx)` : `devis.create`, `devis.update`
(champs modifiés), `devis.statut_transition` (from/to), `devis.revise` (lignée),
`devis.convert` (commande, officialisation, clé, jeton), `devis.delete`.
Contexte : user, rôle, IP, user-agent, path, page-key, session — sans PII superflue.
Cas particulier : l'audit de conversion est écrit après COMMIT du moteur commande
(qui journalise lui-même historique + événements commande) — documenté, assumé.

## 10. Patch DB

`db/patches/20260722_devis_workflow_167.sql` (+ preflight/verify/rollback dans
`support/`). Appliqué sur **cerp_test** le 2026-07-22 (backup pris, verify vert,
ownership `cerp_app` réassigné). **cerp_prod NON modifié** — application prod
uniquement après validation humaine explicite.
