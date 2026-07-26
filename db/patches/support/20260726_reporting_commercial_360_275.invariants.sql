-- Banc de réconciliation #275 — LECTURE SEULE NETTE.
--
-- Le script insère un jeu d'essai dans une transaction, exécute les agrégats du
-- Reporting commercial 360 contre un vrai PostgreSQL, puis ANNULE la transaction.
-- Rien n'est conservé : `ROLLBACK` est la dernière instruction, et `ON_ERROR_STOP`
-- garantit qu'une erreur interrompt avant tout COMMIT (il n'y en a aucun).
--
-- Cas couverts (date d'arrêté = 2026-06-30, période = 2026-01-01 → 2026-12-31) :
--   - règlement et avoir POSTÉRIEURS à la date d'arrêté (ne doivent rien changer) ;
--   - avoir en brouillon (ne diminue pas le facturé) ;
--   - facture annulée et facture en brouillon (hors registre) ;
--   - statut hérité minuscule (`emise`) au registre ;
--   - trop-perçu (solde créditeur), qui doit rester visible ;
--   - règlement rejeté (hors encaissement) ;
--   - règlement rattaché en direct sans lettrage (héritage) : affecté, pas « à affecter » ;
--   - avoir imputé à la fois par lien direct ET par allocation (aucun double comptage) ;
--   - expédition postérieure à la date d'arrêté (hors carnet, dans la période) ;
--   - ligne livrée en retard et ligne livrée à l'heure ;
--   - commande interne (jamais additionnée au commercial).
--
-- Attendus vérifiables dans la sortie (voir docs/reporting-commercial-360-275.md) :
--   encours 1780,00 · échu 1180,00 · solde créditeur 50,00
--   balance âgée : non échu 600,00 + 1–30 j 480,00 + 61–90 j 700,00 = 1780,00
--   facturé net HT 1400,00 = 1983,33 brut − 583,33 avoirs
--   somme des clients 1400,00 = facturé net HT
--   règlements non affectés 250,00 · avoirs non affectés 400,00

\set ON_ERROR_STOP on

BEGIN;

-- --- Jeu d'essai -------------------------------------------------------------

CREATE TEMP TABLE t_ctx ON COMMIT DROP AS
SELECT
  (SELECT client_id FROM public.clients ORDER BY client_id LIMIT 1)          AS client_a,
  (SELECT client_id FROM public.clients ORDER BY client_id OFFSET 1 LIMIT 1) AS client_b,
  (SELECT id FROM public.users ORDER BY id LIMIT 1)                          AS actor;

-- Factures ---------------------------------------------------------------------
INSERT INTO public.facture
  (id, numero, client_id, date_emission, date_echeance, statut, total_ht, total_ttc,
   currency, legal_number, issued_at, issued_by, immutable_snapshot, document_checksum_sha256)
SELECT 9000001, 'T275-F1', client_a, DATE '2026-03-01', DATE '2026-04-01', 'ISSUED', 1000.00, 1200.00,
       'EUR', 'T275-F1', TIMESTAMPTZ '2026-03-01 09:00+01', actor, '{}'::jsonb, repeat('a', 64)
FROM t_ctx;

INSERT INTO public.facture (id, numero, client_id, date_emission, statut, total_ht, total_ttc, currency)
SELECT 9000002, 'T275-F2', client_a, DATE '2026-03-05', 'annulee', 4166.67, 5000.00, 'EUR' FROM t_ctx;

INSERT INTO public.facture (id, numero, client_id, date_emission, statut, total_ht, total_ttc, currency)
SELECT 9000003, 'T275-F3', client_a, DATE '2026-03-06', 'DRAFT', 5833.33, 7000.00, 'EUR' FROM t_ctx;

INSERT INTO public.facture (id, numero, client_id, date_emission, date_echeance, statut, total_ht, total_ttc, currency)
SELECT 9000004, 'T275-F4', client_a, DATE '2026-02-01', DATE '2026-07-15', 'emise', 500.00, 600.00, 'EUR' FROM t_ctx;

INSERT INTO public.facture
  (id, numero, client_id, date_emission, date_echeance, statut, total_ht, total_ttc,
   currency, legal_number, issued_at, issued_by, immutable_snapshot, document_checksum_sha256)
SELECT 9000005, 'T275-F5', client_a, DATE '2026-01-10', DATE '2026-01-20', 'ISSUED', 83.33, 100.00,
       'EUR', 'T275-F5', TIMESTAMPTZ '2026-01-10 09:00+01', actor, '{}'::jsonb, repeat('b', 64)
FROM t_ctx;

INSERT INTO public.facture
  (id, numero, client_id, date_emission, date_echeance, statut, total_ht, total_ttc,
   currency, legal_number, issued_at, issued_by, immutable_snapshot, document_checksum_sha256)
SELECT 9000006, 'T275-F6', client_b, DATE '2026-06-01', DATE '2026-06-10', 'ISSUED', 400.00, 480.00,
       'EUR', 'T275-F6', TIMESTAMPTZ '2026-06-01 09:00+02', actor, '{}'::jsonb, repeat('c', 64)
FROM t_ctx;

-- Avoirs -----------------------------------------------------------------------
-- A1 est créé en brouillon puis émis : c'est l'ordre imposé par les triggers #227
-- (les enfants d'une pièce émise sont immuables, l'imputation vient donc avant).
INSERT INTO public.avoir
  (id, numero, client_id, facture_id, date_emission, statut, total_ht, total_ttc,
   currency, legal_number, issued_at, issued_by, immutable_snapshot, document_checksum_sha256)
SELECT 9000001, 'T275-A1', client_a, 9000001, DATE '2026-04-01', 'DRAFT', 166.67, 200.00,
       'EUR', 'T275-A1', TIMESTAMPTZ '2026-04-01 09:00+02', actor, '{}'::jsonb, repeat('d', 64)
FROM t_ctx;

INSERT INTO public.avoir
  (id, numero, client_id, facture_id, date_emission, statut, total_ht, total_ttc,
   currency, legal_number, issued_at, issued_by, immutable_snapshot, document_checksum_sha256)
SELECT 9000002, 'T275-A2', client_a, 9000001, DATE '2026-09-01', 'ISSUED', 83.33, 100.00,
       'EUR', 'T275-A2', TIMESTAMPTZ '2026-09-01 09:00+02', actor, '{}'::jsonb, repeat('e', 64)
FROM t_ctx;

INSERT INTO public.avoir (id, numero, client_id, facture_id, date_emission, statut, total_ht, total_ttc, currency)
SELECT 9000003, 'T275-A3', client_a, 9000004, DATE '2026-05-01', 'DRAFT', 250.00, 300.00, 'EUR' FROM t_ctx;

INSERT INTO public.avoir
  (id, numero, client_id, facture_id, date_emission, statut, total_ht, total_ttc,
   currency, legal_number, issued_at, issued_by, immutable_snapshot, document_checksum_sha256)
SELECT 9000004, 'T275-A4', client_a, NULL, DATE '2026-05-05', 'ISSUED', 333.33, 400.00,
       'EUR', 'T275-A4', TIMESTAMPTZ '2026-05-05 09:00+02', actor, '{}'::jsonb, repeat('f', 64)
FROM t_ctx;

-- A1 est imputé À LA FOIS par lien direct et par allocation : le calcul ne doit
-- compter 200 qu'une seule fois.
INSERT INTO public.avoir_source_allocations
  (avoir_id, facture_id, source_type, source_id, source_line_id, amount_ttc, allocation_status, created_at, created_by)
SELECT 9000001, 9000001, 'INVOICE_LINE', 'T275', 'T275-A1-L1', 200.00, 'CONSUMED',
       TIMESTAMPTZ '2026-04-01 10:00+02', actor
FROM t_ctx;

-- Émission de A1 une fois l'imputation posée.
UPDATE public.avoir SET statut = 'ISSUED' WHERE id = 9000001;

-- Règlements -------------------------------------------------------------------
INSERT INTO public.paiement (id, client_id, facture_id, date_paiement, montant, mode, status, workflow_status, currency)
SELECT 9000001, client_a, NULL, DATE '2026-05-01', 300.00, 'VIREMENT', 'ALLOCATED', 'ALLOCATED', 'EUR' FROM t_ctx;

INSERT INTO public.paiement (id, client_id, facture_id, date_paiement, montant, mode, status, workflow_status, currency)
SELECT 9000002, client_a, NULL, DATE '2026-08-01', 500.00, 'VIREMENT', 'ALLOCATED', 'ALLOCATED', 'EUR' FROM t_ctx;

-- Rattachement direct hérité, sans ligne de lettrage : sur-règlement de F5.
INSERT INTO public.paiement (id, client_id, facture_id, date_paiement, montant, mode, status, workflow_status, currency)
SELECT 9000003, client_a, 9000005, DATE '2026-02-01', 150.00, 'CHEQUE', 'ALLOCATED', 'ALLOCATED', 'EUR' FROM t_ctx;

INSERT INTO public.paiement (id, client_id, facture_id, date_paiement, montant, mode, status, workflow_status, currency)
SELECT 9000004, client_a, NULL, DATE '2026-06-01', 250.00, 'VIREMENT', 'UNALLOCATED', 'RECORDED', 'EUR' FROM t_ctx;

INSERT INTO public.paiement (id, client_id, facture_id, date_paiement, montant, mode, status, workflow_status, currency)
SELECT 9000005, client_a, NULL, DATE '2026-06-02', 999.00, 'VIREMENT', 'REJECTED', 'RECORDED', 'EUR' FROM t_ctx;

INSERT INTO public.paiement_allocations (paiement_id, facture_id, amount_ttc, created_at, created_by)
SELECT 9000001, 9000001, 300.00, TIMESTAMPTZ '2026-05-01 10:00+02', actor FROM t_ctx;

-- Lettrage postérieur à la date d'arrêté : invisible au 30/06.
INSERT INTO public.paiement_allocations (paiement_id, facture_id, amount_ttc, created_at, created_by)
SELECT 9000002, 9000001, 500.00, TIMESTAMPTZ '2026-08-01 10:00+02', actor FROM t_ctx;

-- Devis --------------------------------------------------------------------------
INSERT INTO public.devis (id, numero, client_id, user_id, date_creation, date_validite, statut, total_ht, total_ttc, root_devis_id, version_number)
SELECT 9000001, 'T275-D1', client_a, actor, TIMESTAMP '2026-02-01 10:00', DATE '2026-03-01', 'ENVOYE', 5000.00, 6000.00, 9000001, 1 FROM t_ctx;
INSERT INTO public.devis (id, numero, client_id, user_id, date_creation, date_validite, statut, total_ht, total_ttc, root_devis_id, version_number)
SELECT 9000002, 'T275-D2', client_a, actor, TIMESTAMP '2026-02-10 10:00', DATE '2026-06-01', 'ACCEPTE', 3000.00, 3600.00, 9000002, 1 FROM t_ctx;
INSERT INTO public.devis (id, numero, client_id, user_id, date_creation, date_validite, statut, total_ht, total_ttc, root_devis_id, version_number)
SELECT 9000003, 'T275-D3', client_b, actor, TIMESTAMP '2026-03-01 10:00', DATE '2026-06-01', 'REFUSE', 2000.00, 2400.00, 9000003, 1 FROM t_ctx;
INSERT INTO public.devis (id, numero, client_id, user_id, date_creation, date_validite, statut, total_ht, total_ttc, root_devis_id, version_number)
SELECT 9000004, 'T275-D4', client_a, actor, TIMESTAMP '2026-03-02 10:00', DATE '2026-06-01', 'BROUILLON', 9999.00, 11998.80, 9000004, 1 FROM t_ctx;
INSERT INTO public.devis (id, numero, client_id, user_id, date_creation, date_validite, statut, total_ht, total_ttc, root_devis_id, version_number)
SELECT 9000005, 'T275-D5', client_a, actor, TIMESTAMP '2026-03-03 10:00', DATE '2026-06-01', 'ANNULE', 8888.00, 10665.60, 9000005, 1 FROM t_ctx;
INSERT INTO public.devis (id, numero, client_id, user_id, date_creation, date_validite, statut, total_ht, total_ttc, root_devis_id, version_number)
SELECT 9000006, 'T275-D6', client_b, actor, TIMESTAMP '2026-04-01 10:00', DATE '2026-05-01', 'EXPIRE', 1000.00, 1200.00, 9000006, 1 FROM t_ctx;

-- Commandes et livraisons ----------------------------------------------------------
INSERT INTO public.commande_client (id, numero, client_id, date_commande, order_type, total_ht, total_ttc)
SELECT 9000001, 'T275-C1', client_a, DATE '2026-03-01', 'FERME', 2000.00, 2400.00 FROM t_ctx;
-- Une commande interne exige un magasin de destination (contrainte #153).
-- `magasins` est vide sur cerp_test : on en crée un le temps de la transaction.
INSERT INTO public.magasins (id, code_magasin, libelle)
VALUES ('33333333-2275-4333-8333-333333333333', 'T275-MAG', 'Magasin de banc #275');

INSERT INTO public.commande_client (id, numero, client_id, date_commande, order_type, total_ht, total_ttc, dest_stock_magasin_id)
SELECT 9000002, 'T275-C2', client_a, DATE '2026-03-02', 'INTERNE', 500.00, 600.00,
       '33333333-2275-4333-8333-333333333333' FROM t_ctx;
INSERT INTO public.commande_client (id, numero, client_id, date_commande, order_type, total_ht, total_ttc)
SELECT 9000003, 'T275-C3', client_b, DATE '2026-06-01', 'FERME', 300.00, 360.00 FROM t_ctx;

-- `total_ht` / `total_ttc` sont des colonnes générées sur commande_ligne.
INSERT INTO public.commande_ligne (id, commande_id, designation, quantite, prix_unitaire_ht, remise_ligne, taux_tva, delai_client)
VALUES
  (9000001, 9000001, 'T275 pièce A', 10, 100.00, 0, 20, DATE '2026-05-01'),
  (9000002, 9000003, 'T275 pièce B', 5, 60.00, 0, 20, DATE '2026-08-01');

INSERT INTO public.bon_livraison (id, numero, statut, client_id, commande_id, date_creation, date_expedition)
SELECT '11111111-2275-4111-8111-111111111111', 'T275-BL1', 'SHIPPED', client_a, 9000001, DATE '2026-04-10', DATE '2026-04-15' FROM t_ctx;
INSERT INTO public.bon_livraison (id, numero, statut, client_id, commande_id, date_creation, date_expedition)
SELECT '22222222-2275-4222-8222-222222222222', 'T275-BL2', 'SHIPPED', client_b, 9000003, DATE '2026-08-25', DATE '2026-09-01' FROM t_ctx;

INSERT INTO public.bon_livraison_ligne (bon_livraison_id, ordre, designation, quantite, commande_ligne_id, delai_client)
VALUES
  ('11111111-2275-4111-8111-111111111111', 1, 'T275 pièce A', 4, 9000001, DATE '2026-05-01'),
  ('22222222-2275-4222-8222-222222222222', 1, 'T275 pièce B', 5, 9000002, DATE '2026-08-01');

\echo ''
\echo '################ AGRÉGATS RÉELS #275 ################'
\echo ''

-- Rejeu des requêtes générées par le code de production.
\i /tmp/cerp-reporting-275-queries.sql

\echo ''
\echo '################ FIN — ANNULATION ################'

ROLLBACK;

\echo ''
\echo '=== Preuve d''annulation : les tables doivent être revenues à leur état initial ==='
SELECT 'facture' AS relation, count(*) FROM public.facture
UNION ALL SELECT 'avoir', count(*) FROM public.avoir
UNION ALL SELECT 'paiement', count(*) FROM public.paiement
UNION ALL SELECT 'devis', count(*) FROM public.devis
UNION ALL SELECT 'commande_client', count(*) FROM public.commande_client
UNION ALL SELECT 'bon_livraison', count(*) FROM public.bon_livraison
ORDER BY 1;
