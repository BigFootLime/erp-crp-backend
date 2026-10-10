\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database() <> 'purchasecopy1067' THEN
    RAISE EXCEPTION 'isolated_fixture_database_required';
  END IF;
END $$;
BEGIN;
CREATE TABLE public.pieces_techniques_achats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), piece_technique_id uuid NOT NULL,
  piece_technique_version_id uuid NOT NULL, phase integer, famille_piece_id uuid,
  nom text, designation text, designation_2 text, designation_3 text, article_id uuid,
  fournisseur_id uuid, fournisseur_nom text, fournisseur_code text,
  quantite numeric NOT NULL DEFAULT 1, quantite_brut_mm numeric, longueur_mm numeric,
  coefficient_chute numeric, quantite_pieces numeric, prix_par_quantite numeric,
  tarif numeric, prix numeric(16,6), unite_prix text, pu_achat numeric(16,6), tva_achat numeric,
  total_achat_ht numeric(12,2), total_achat_ttc numeric(12,2), type_achat text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.pieces_techniques_achats (
  piece_technique_id, piece_technique_version_id, phase, famille_piece_id, nom,
  designation, designation_2, designation_3, article_id, fournisseur_id, fournisseur_nom,
  fournisseur_code, quantite, quantite_brut_mm, longueur_mm, coefficient_chute, quantite_pieces,
  prix_par_quantite, tarif, prix, unite_prix, pu_achat, tva_achat, total_achat_ht, total_achat_ttc, type_achat
) VALUES
('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',10,'30000000-0000-0000-0000-000000000001',
 'MAT','ROND 42CrMo4','BRUT Ø35','Certificat matière','40000000-0000-0000-0000-000000000001',
 '50000000-0000-0000-0000-000000000001','RF — Métaux','RF-MAT',110.5,110,3000,1.13,12,1,0.025,0.025,'mm',0.025,5.5,2.76,2.91,'MATIERE'),
('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',30,NULL,
 'TR','Nitruration','Selon plan A','Certificat TR','40000000-0000-0000-0000-000000000002',
 '50000000-0000-0000-0000-000000000002','RF — Traitements','RF-TR',12,NULL,NULL,NULL,12,1,4,4,'PCE',4,20,48,57.60,'TRAITEMENT'),
('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',NULL,NULL,
 'ZERO','Prestation gratuite',NULL,NULL,NULL,NULL,NULL,NULL,1,NULL,NULL,NULL,NULL,NULL,NULL,0,'PCE',0,NULL,0,NULL,'DIVERS');
INSERT INTO public.pieces_techniques_achats (piece_technique_id,piece_technique_version_id,nom,quantite)
VALUES ('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000009','OTHER-VERSION',99),
       ('10000000-0000-0000-0000-000000000009','20000000-0000-0000-0000-000000000001','OTHER-PIECE',99);
CREATE TEMP TABLE source_before AS SELECT to_jsonb(a) AS value FROM public.pieces_techniques_achats a;
\i :query_file
EXECUTE copy_purchases('10000000-0000-0000-0000-000000000001',
                      '20000000-0000-0000-0000-000000000002',
                      '20000000-0000-0000-0000-000000000001');
DO $$
BEGIN
  IF (SELECT count(*) FROM public.pieces_techniques_achats WHERE piece_technique_version_id='20000000-0000-0000-0000-000000000002') <> 3 THEN
    RAISE EXCEPTION 'purchase_clone_source_scope_changed';
  END IF;
  IF EXISTS (
    (SELECT to_jsonb(a)-ARRAY['id','piece_technique_version_id','created_at','updated_at'] FROM public.pieces_techniques_achats a
     WHERE piece_technique_id='10000000-0000-0000-0000-000000000001' AND piece_technique_version_id='20000000-0000-0000-0000-000000000001'
     EXCEPT
     SELECT to_jsonb(a)-ARRAY['id','piece_technique_version_id','created_at','updated_at'] FROM public.pieces_techniques_achats a
     WHERE piece_technique_version_id='20000000-0000-0000-0000-000000000002')
    UNION ALL
    (SELECT to_jsonb(a)-ARRAY['id','piece_technique_version_id','created_at','updated_at'] FROM public.pieces_techniques_achats a
     WHERE piece_technique_version_id='20000000-0000-0000-0000-000000000002'
     EXCEPT
     SELECT to_jsonb(a)-ARRAY['id','piece_technique_version_id','created_at','updated_at'] FROM public.pieces_techniques_achats a
     WHERE piece_technique_id='10000000-0000-0000-0000-000000000001' AND piece_technique_version_id='20000000-0000-0000-0000-000000000001')
  ) THEN RAISE EXCEPTION 'purchase_clone_business_values_changed'; END IF;
  IF EXISTS (SELECT value FROM source_before EXCEPT SELECT to_jsonb(a) FROM public.pieces_techniques_achats a) THEN
    RAISE EXCEPTION 'purchase_clone_modified_source';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pieces_techniques_achats a JOIN public.pieces_techniques_achats b ON a.id=b.id
             WHERE a.piece_technique_version_id='20000000-0000-0000-0000-000000000001' AND b.piece_technique_version_id='20000000-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'purchase_clone_reused_identity';
  END IF;
END $$;
ROLLBACK;
SELECT 'Purchase copy values, nulls, scope, fresh identities and source preservation PASS' AS result;
