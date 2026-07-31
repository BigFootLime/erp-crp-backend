-- Contrôles de garde — 20260729_of_versioning_replanification_ar_370.sql
--
-- Exerce en base les garanties que le code seul ne peut pas tenir : unicité sous
-- concurrence, idempotence, immuabilité. Chaque contrôle échoue bruyamment.
--
-- Le script crée puis retire ses propres données ; il se termine par un ROLLBACK
-- et ne laisse rien derrière lui.

BEGIN;

DO $$
DECLARE
  v_of bigint;
  v_piece uuid;
  v_r0 uuid;
  v_r1 uuid;
  v_op uuid;
  v_err text;
BEGIN
  SELECT id INTO v_piece FROM public.pieces_techniques LIMIT 1;
  IF v_piece IS NULL THEN
    RAISE EXCEPTION 'Aucune pièce technique : impossible de créer un OF de contrôle';
  END IF;

  INSERT INTO public.ordres_fabrication (numero, piece_technique_id, quantite_lancee, statut)
  VALUES ('OF-GUARD-374', v_piece, 40, 'EN_COURS')
  RETURNING id INTO v_of;

  ---------------------------------------------------------------------------
  RAISE NOTICE '1) Une seule révision ACTIVE par OF';
  ---------------------------------------------------------------------------
  INSERT INTO public.of_revisions (of_id, revision_rank, revision_code, statut, snapshot, snapshot_sha256, activated_at)
  VALUES (v_of, 0, 'R00', 'ACTIVE', '{"v":0}'::jsonb, repeat('a', 64), now())
  RETURNING id INTO v_r0;

  -- Le motif est fourni : sans lui, `of_revisions_motif_ck` se déclencherait avant
  -- l'index d'unicité et le contrôle porterait sur autre chose que sur l'unicité.
  BEGIN
    INSERT INTO public.of_revisions (of_id, revision_rank, revision_code, statut, snapshot, snapshot_sha256, motif)
    VALUES (v_of, 1, 'R01', 'ACTIVE', '{"v":1}'::jsonb, repeat('b', 64), 'Tentative concurrente');
    RAISE EXCEPTION 'ECHEC : deux révisions ACTIVE acceptées sur le même OF';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '   ok — la seconde révision ACTIVE est refusée';
  END;

  ---------------------------------------------------------------------------
  RAISE NOTICE '2) Motif obligatoire dès R01';
  ---------------------------------------------------------------------------
  BEGIN
    INSERT INTO public.of_revisions (of_id, revision_rank, revision_code, statut, snapshot, snapshot_sha256)
    VALUES (v_of, 1, 'R01', 'BROUILLON', '{"v":1}'::jsonb, repeat('b', 64));
    RAISE EXCEPTION 'ECHEC : R01 acceptée sans motif';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '   ok — R01 sans motif refusée';
  END;

  INSERT INTO public.of_revisions (of_id, revision_rank, revision_code, statut, snapshot, snapshot_sha256, motif)
  VALUES (v_of, 1, 'R01', 'BROUILLON', '{"v":1}'::jsonb, repeat('b', 64), 'Nouvelle prise de pièce')
  RETURNING id INTO v_r1;

  ---------------------------------------------------------------------------
  RAISE NOTICE '3) Le contenu d''une révision est immuable';
  ---------------------------------------------------------------------------
  BEGIN
    UPDATE public.of_revisions SET snapshot = '{"v":99}'::jsonb WHERE id = v_r1;
    RAISE EXCEPTION 'ECHEC : instantané de révision modifiable';
  EXCEPTION WHEN sqlstate '55000' THEN
    RAISE NOTICE '   ok — instantané immuable';
  END;

  BEGIN
    DELETE FROM public.of_revisions WHERE id = v_r1;
    RAISE EXCEPTION 'ECHEC : révision supprimable';
  EXCEPTION WHEN sqlstate '55000' THEN
    RAISE NOTICE '   ok — révision non supprimable';
  END;

  -- Le statut, lui, évolue : c'est le cycle de vie.
  UPDATE public.of_revisions SET statut = 'OBSOLETE', superseded_at = now() WHERE id = v_r0;
  UPDATE public.of_revisions SET statut = 'ACTIVE', activated_at = now() WHERE id = v_r1;
  RAISE NOTICE '   ok — R00 obsolète, R01 active';

  BEGIN
    UPDATE public.of_revisions SET statut = 'ACTIVE' WHERE id = v_r0;
    RAISE EXCEPTION 'ECHEC : révision obsolète réactivable';
  EXCEPTION WHEN sqlstate '55000' THEN
    RAISE NOTICE '   ok — une révision obsolète ne se réactive pas';
  END;

  ---------------------------------------------------------------------------
  RAISE NOTICE '4) Une phase coexiste entre deux révisions du même OF';
  ---------------------------------------------------------------------------
  INSERT INTO public.of_operations (of_id, revision_id, phase, designation)
  VALUES (v_of, v_r0, 30, 'FRAISAGE CN R00')
  RETURNING id INTO v_op;

  INSERT INTO public.of_operations (of_id, revision_id, phase, designation)
  VALUES (v_of, v_r1, 30, 'FRAISAGE CN R01');
  RAISE NOTICE '   ok — phase 30 présente dans R00 et R01 sans collision';

  BEGIN
    INSERT INTO public.of_operations (of_id, revision_id, phase, designation)
    VALUES (v_of, v_r1, 30, 'DOUBLON');
    RAISE EXCEPTION 'ECHEC : phase dupliquée dans la même révision';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '   ok — phase unique au sein d''une révision';
  END;

  ---------------------------------------------------------------------------
  RAISE NOTICE '5) Pointages et VISA restent attachés à leur révision d''origine';
  ---------------------------------------------------------------------------
  INSERT INTO public.of_operation_visas (of_operation_id, initials)
  VALUES (v_op, 'AG');

  BEGIN
    UPDATE public.of_operations SET designation = 'REECRITE' WHERE id = v_op;
    RAISE EXCEPTION 'ECHEC : opération d''une révision obsolète modifiable';
  EXCEPTION WHEN sqlstate '55000' THEN
    RAISE NOTICE '   ok — l''opération de R00 est gelée, son VISA avec elle';
  END;

  BEGIN
    DELETE FROM public.of_operation_visas WHERE of_operation_id = v_op;
    RAISE EXCEPTION 'ECHEC : VISA supprimable';
  EXCEPTION WHEN sqlstate '55000' THEN
    RAISE NOTICE '   ok — un VISA se révoque, il ne se supprime pas';
  END;

  BEGIN
    INSERT INTO public.of_operation_visas (of_operation_id, initials) VALUES (v_op, 'TB');
    RAISE EXCEPTION 'ECHEC : deux VISA vivants sur la même phase';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '   ok — un seul VISA vivant par phase';
  END;

  ---------------------------------------------------------------------------
  RAISE NOTICE '6) Idempotence sous concurrence';
  ---------------------------------------------------------------------------
  INSERT INTO public.of_time_variance_proposals
    (of_id, revision_id, phase, reference_time, new_time, variation_pct, outcome, cause, idempotency_key)
  VALUES (v_of, v_r1, 30, 4, 5, 25.00, 'REPLANIFICATION', 'DERIVE_TEMPS_USINAGE', 'guard-374-a');

  BEGIN
    INSERT INTO public.of_time_variance_proposals
      (of_id, revision_id, phase, reference_time, new_time, variation_pct, outcome, cause, idempotency_key)
    VALUES (v_of, v_r1, 30, 4, 5, 25.00, 'REPLANIFICATION', 'DERIVE_TEMPS_USINAGE', 'guard-374-a');
    RAISE EXCEPTION 'ECHEC : proposition rejouée en double';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '   ok — une clé d''idempotence ne produit qu''une proposition';
  END;

  ---------------------------------------------------------------------------
  RAISE NOTICE '7) Référence absente => revue obligatoire, sans pourcentage';
  ---------------------------------------------------------------------------
  BEGIN
    INSERT INTO public.of_time_variance_proposals
      (of_id, revision_id, phase, reference_time, new_time, variation_pct, outcome, cause)
    VALUES (v_of, v_r1, 40, NULL, 5, 12.00, 'REPLANIFICATION', 'MACHINE');
    RAISE EXCEPTION 'ECHEC : pourcentage accepté sans référence';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '   ok — pas de pourcentage sans référence exploitable';
  END;

  INSERT INTO public.of_time_variance_proposals
    (of_id, revision_id, phase, reference_time, new_time, variation_pct, outcome, cause, review_required)
  VALUES (v_of, v_r1, 40, NULL, 5, NULL, 'REVUE', 'MACHINE', true);
  RAISE NOTICE '   ok — référence absente enregistrée en REVUE';

  ---------------------------------------------------------------------------
  RAISE NOTICE '8) Un seul planning ACTIF et un seul brouillon en circuit';
  ---------------------------------------------------------------------------
  INSERT INTO public.of_planning_versions (of_id, version_rank, statut, payload, payload_sha256)
  VALUES (v_of, 0, 'ACTIF', '{"p":0}'::jsonb, repeat('c', 64));

  BEGIN
    INSERT INTO public.of_planning_versions (of_id, version_rank, statut, payload, payload_sha256)
    VALUES (v_of, 1, 'ACTIF', '{"p":1}'::jsonb, repeat('d', 64));
    RAISE EXCEPTION 'ECHEC : deux plannings ACTIF';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '   ok — un seul planning ACTIF';
  END;

  INSERT INTO public.of_planning_versions (of_id, version_rank, statut, payload, payload_sha256)
  VALUES (v_of, 1, 'BROUILLON', '{"p":1}'::jsonb, repeat('d', 64));

  BEGIN
    INSERT INTO public.of_planning_versions (of_id, version_rank, statut, payload, payload_sha256)
    VALUES (v_of, 2, 'SOUMIS', '{"p":2}'::jsonb, repeat('e', 64));
    RAISE EXCEPTION 'ECHEC : deux brouillons en circuit simultanément';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '   ok — un seul brouillon en circuit à la fois';
  END;

  ---------------------------------------------------------------------------
  RAISE NOTICE '9) Motif AUTRE => commentaire exigé';
  ---------------------------------------------------------------------------
  BEGIN
    INSERT INTO public.ar_recalage_dossiers (of_id, motif) VALUES (v_of, 'AUTRE');
    RAISE EXCEPTION 'ECHEC : motif AUTRE accepté sans commentaire';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '   ok — « Autre » exige un commentaire';
  END;

  INSERT INTO public.ar_recalage_dossiers (of_id, motif, commentaire)
  VALUES (v_of, 'AUTRE', 'Report demandé par le client');
  INSERT INTO public.ar_recalage_dossiers (of_id, motif) VALUES (v_of, 'MACHINE');
  RAISE NOTICE '   ok — dossiers créés, aucun destinataire ni envoi dans le modèle';

  ---------------------------------------------------------------------------
  RAISE NOTICE '10) Document figé : un seul officiel, payload immuable';
  ---------------------------------------------------------------------------
  INSERT INTO public.of_documents (of_id, revision_id, payload, payload_sha256, pdf_sha256, statut)
  VALUES (v_of, v_r1, '{"d":1}'::jsonb, repeat('f', 64), repeat('1', 64), 'OFFICIEL');

  BEGIN
    INSERT INTO public.of_documents (of_id, revision_id, payload, payload_sha256, statut)
    VALUES (v_of, v_r1, '{"d":2}'::jsonb, repeat('0', 64), 'OFFICIEL');
    RAISE EXCEPTION 'ECHEC : deux documents officiels sur la même révision';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '   ok — un seul document officiel par révision';
  END;

  BEGIN
    UPDATE public.of_documents SET payload = '{"d":9}'::jsonb WHERE revision_id = v_r1;
    RAISE EXCEPTION 'ECHEC : payload de document modifiable';
  EXCEPTION WHEN sqlstate '55000' THEN
    RAISE NOTICE '   ok — le payload figé est immuable';
  END;

  BEGIN
    UPDATE public.of_documents SET pdf_sha256 = repeat('2', 64) WHERE revision_id = v_r1;
    RAISE EXCEPTION 'ECHEC : empreinte PDF réécrite';
  EXCEPTION WHEN sqlstate '55000' THEN
    RAISE NOTICE '   ok — l''empreinte du binaire ne s''écrit qu''une fois';
  END;

  -- La réimpression, elle, est comptée.
  UPDATE public.of_documents
    SET reprint_count = reprint_count + 1, last_reprinted_at = now()
    WHERE revision_id = v_r1;
  RAISE NOTICE '   ok — la réimpression est comptée sans toucher au contenu';

  RAISE NOTICE '';
  RAISE NOTICE 'TOUS LES CONTROLES DE GARDE SONT PASSES';
END $$;

ROLLBACK;
