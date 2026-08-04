-- Read-only preflight for issue #314 / GPT56-CERP-0005.
-- This release does not add or mutate database schema. The append-only
-- commande_historique remains the sole persisted command-status authority.
\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $$
BEGIN
  IF to_regclass('public.commande_client') IS NULL
     OR to_regclass('public.commande_historique') IS NULL
     OR to_regclass('public.commande_client_workflow_checkpoint') IS NULL
     OR to_regclass('public.commande_client_event_log') IS NULL THEN
    RAISE EXCEPTION '#314 prerequisites are missing; apply the existing workflow patches first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'commande_client'
      AND column_name = 'statut'
  ) THEN
    RAISE EXCEPTION '#314 refuses a commande_client.statut projection; commande_historique is authoritative';
  END IF;

  IF EXISTS (
    WITH latest AS (
      SELECT DISTINCT ON (commande_id) commande_id, nouveau_statut
      FROM public.commande_historique
      ORDER BY commande_id, date_action DESC, id DESC
    )
    SELECT 1
    FROM latest
    WHERE nouveau_statut IS NOT NULL
      AND nouveau_statut NOT IN (
        'BROUILLON','EN_ANALYSE','ATTENTE_TECHNIQUE','ATTENTE_STOCK','ATTENTE_OF','ATTENTE_PLANNING',
        'PLANNING_VALIDE','AR_PRET','AR_ENVOYE','EN_PRODUCTION','PRODUCTION_TERMINEE','CONTROLE_QUALITE',
        'PRET_LIVRAISON','LIVRE','FACTURE','ARCHIVE','BLOQUE',
        'ENREGISTREE','PLANIFIEE','AR_ENVOYEE','LIVREE'
      )
  ) THEN
    RAISE EXCEPTION '#314 preflight refused: an unknown latest command status requires manual repair';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.commande_client_workflow_checkpoint
    WHERE status NOT IN ('pending','active','blocked','done','skipped')
  ) THEN
    RAISE EXCEPTION '#314 preflight refused: an invalid checkpoint status exists';
  END IF;

  IF EXISTS (
    SELECT commande_id, checkpoint_code
    FROM public.commande_client_workflow_checkpoint
    GROUP BY commande_id, checkpoint_code
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION '#314 preflight refused: duplicate command checkpoint codes exist';
  END IF;

  -- Compare every persisted checkpoint with the exact graph projection. This is
  -- deliberately fail-closed: a future checkpoint already marked done, a
  -- missing/extra checkpoint, or a bad internal/full-stock skip aborts deploy.
  IF EXISTS (
    WITH latest_raw AS (
      SELECT DISTINCT ON (commande_id) commande_id, nouveau_statut
      FROM public.commande_historique
      ORDER BY commande_id, date_action DESC, id DESC
    ), state AS (
      SELECT
        cc.id AS commande_id,
        upper(COALESCE(cc.order_type, '')) AS order_type,
        CASE COALESCE(l.nouveau_statut, 'BROUILLON')
          WHEN 'ENREGISTREE' THEN 'EN_ANALYSE'
          WHEN 'PLANIFIEE' THEN 'PLANNING_VALIDE'
          WHEN 'AR_ENVOYEE' THEN 'AR_ENVOYE'
          WHEN 'LIVREE' THEN 'LIVRE'
          ELSE COALESCE(l.nouveau_statut, 'BROUILLON')
        END AS canonical_status
      FROM public.commande_client cc
      LEFT JOIN latest_raw l ON l.commande_id = cc.id
    ), effective_state AS (
      SELECT s.*,
        CASE
          WHEN s.canonical_status <> 'BLOQUE' THEN s.canonical_status
          ELSE (
            SELECT cp.metadata->>'previous_status_before_block'
            FROM public.commande_client_workflow_checkpoint cp
            WHERE cp.commande_id = s.commande_id AND cp.status = 'blocked'
            ORDER BY cp.id
            LIMIT 1
          )
        END AS effective_status,
        EXISTS (
          SELECT 1
          FROM public.commande_client_workflow_checkpoint cp
          WHERE cp.commande_id = s.commande_id
            AND cp.metadata->>'skip_reason' = 'commande_fully_reserved_from_stock'
        ) AS full_stock_path
      FROM state s
    ), command_projection AS (
      SELECT es.*,
        CASE es.effective_status
          WHEN 'BROUILLON' THEN 1 WHEN 'EN_ANALYSE' THEN 2
          WHEN 'ATTENTE_TECHNIQUE' THEN 3 WHEN 'ATTENTE_STOCK' THEN 4
          WHEN 'ATTENTE_OF' THEN 5 WHEN 'ATTENTE_PLANNING' THEN 6
          WHEN 'PLANNING_VALIDE' THEN CASE WHEN es.order_type = 'INTERNE' THEN 9 ELSE 7 END
          WHEN 'AR_PRET' THEN 8 WHEN 'AR_ENVOYE' THEN 9
          WHEN 'EN_PRODUCTION' THEN 10
          WHEN 'PRODUCTION_TERMINEE' THEN 11 WHEN 'CONTROLE_QUALITE' THEN 11
          WHEN 'PRET_LIVRAISON' THEN 12 WHEN 'LIVRE' THEN CASE WHEN es.order_type = 'INTERNE' THEN 14 ELSE 13 END
          WHEN 'FACTURE' THEN 14 WHEN 'ARCHIVE' THEN 15
          ELSE NULL
        END AS active_position,
        es.order_type = 'INTERNE'
          AND es.effective_status IN (
            'ATTENTE_PLANNING','PLANNING_VALIDE','EN_PRODUCTION','PRODUCTION_TERMINEE',
            'CONTROLE_QUALITE','PRET_LIVRAISON','LIVRE','ARCHIVE'
          ) AS internal_path
      FROM effective_state es
    ), checkpoint_definition(checkpoint_code, checkpoint_position, sort_order) AS (
      VALUES
        ('order_intake',1,10), ('commercial_review',2,20), ('technical_analysis',3,30),
        ('stock_check',4,40), ('of_generation',5,50), ('planning_validation',6,60),
        ('ar_preparation',7,70), ('ar_sent',8,80), ('production_launch',9,90),
        ('production_completion',10,100), ('quality_control',11,110), ('delivery',12,120),
        ('invoicing',13,130), ('archive',14,140)
    ), expected AS (
      SELECT
        p.commande_id,
        d.checkpoint_code,
        d.sort_order,
        CASE
          WHEN p.internal_path AND d.checkpoint_position IN (2,4,7,8,13) THEN 'skipped'
          WHEN NOT p.internal_path AND p.full_stock_path AND d.checkpoint_position IN (5,6,7,8,9,10,11) THEN 'skipped'
          WHEN d.checkpoint_position < p.active_position OR p.active_position = 15 THEN 'done'
          WHEN d.checkpoint_position = p.active_position THEN
            CASE WHEN p.canonical_status = 'BLOQUE' THEN 'blocked' ELSE 'active' END
          ELSE 'pending'
        END AS checkpoint_status
      FROM command_projection p
      CROSS JOIN checkpoint_definition d
    ), anomaly AS (
      SELECT COALESCE(e.commande_id, cp.commande_id) AS commande_id
      FROM expected e
      FULL OUTER JOIN public.commande_client_workflow_checkpoint cp
        ON cp.commande_id = e.commande_id AND cp.checkpoint_code = e.checkpoint_code
      WHERE e.commande_id IS NULL
         OR cp.commande_id IS NULL
         OR cp.status IS DISTINCT FROM e.checkpoint_status
         OR cp.sort_order IS DISTINCT FROM e.sort_order
    )
    SELECT 1 FROM anomaly
  ) THEN
    RAISE EXCEPTION '#314 preflight refused: checkpoint graph is inconsistent with normalized history/order type';
  END IF;
END $$;

WITH latest AS (
  SELECT DISTINCT ON (commande_id) commande_id, nouveau_statut
  FROM public.commande_historique
  ORDER BY commande_id, date_action DESC, id DESC
)
SELECT
  (SELECT COUNT(*) FROM public.commande_client cc LEFT JOIN latest l ON l.commande_id = cc.id WHERE l.commande_id IS NULL)
    AS commandes_without_history_runtime_infers_brouillon,
  COUNT(*) FILTER (WHERE nouveau_statut IN ('ENREGISTREE','PLANIFIEE','AR_ENVOYEE','LIVREE'))
    AS latest_legacy_aliases_runtime_normalized,
  COUNT(*) FILTER (WHERE nouveau_statut = 'BLOQUE') AS currently_blocked
FROM latest;

-- Diagnostic subset for operators. The complete graph check above has already
-- failed closed before this report can be displayed.
WITH latest_raw AS (
  SELECT DISTINCT ON (commande_id) commande_id, nouveau_statut
  FROM public.commande_historique
  ORDER BY commande_id, date_action DESC, id DESC
), state AS (
  SELECT cc.id AS commande_id, cc.order_type,
    CASE COALESCE(l.nouveau_statut, 'BROUILLON')
      WHEN 'ENREGISTREE' THEN 'EN_ANALYSE'
      WHEN 'PLANIFIEE' THEN 'PLANNING_VALIDE'
      WHEN 'AR_ENVOYEE' THEN 'AR_ENVOYE'
      WHEN 'LIVREE' THEN 'LIVRE'
      ELSE COALESCE(l.nouveau_statut, 'BROUILLON')
    END AS canonical_status
  FROM public.commande_client cc
  LEFT JOIN latest_raw l ON l.commande_id = cc.id
), checkpoint_state AS (
  SELECT commande_id,
    COUNT(*) AS checkpoint_count,
    COUNT(*) FILTER (WHERE status IN ('active','blocked')) AS controlling_count,
    COUNT(*) FILTER (WHERE status = 'blocked') AS blocked_count,
    COUNT(*) FILTER (
      WHERE status = 'blocked'
        AND metadata->>'previous_status_before_block' IN (
          'BROUILLON','EN_ANALYSE','ATTENTE_TECHNIQUE','ATTENTE_STOCK','ATTENTE_OF','ATTENTE_PLANNING',
          'PLANNING_VALIDE','AR_PRET','AR_ENVOYE','EN_PRODUCTION','PRODUCTION_TERMINEE','CONTROLE_QUALITE',
          'PRET_LIVRAISON','LIVRE','FACTURE'
        )
    ) AS resumable_blocked_count,
    MAX(checkpoint_code) FILTER (WHERE status = 'active') AS active_code
  FROM public.commande_client_workflow_checkpoint
  GROUP BY commande_id
)
SELECT
  s.commande_id,
  s.canonical_status,
  cp.controlling_count,
  cp.blocked_count,
  cp.active_code,
  CASE
    WHEN s.canonical_status = 'BROUILLON' THEN 'order_intake'
    WHEN s.canonical_status = 'EN_ANALYSE' THEN 'commercial_review'
    WHEN s.canonical_status = 'ATTENTE_TECHNIQUE' THEN 'technical_analysis'
    WHEN s.canonical_status = 'ATTENTE_STOCK' THEN 'stock_check'
    WHEN s.canonical_status = 'ATTENTE_OF' THEN 'of_generation'
    WHEN s.canonical_status = 'ATTENTE_PLANNING' THEN 'planning_validation'
    WHEN s.canonical_status = 'PLANNING_VALIDE' AND upper(COALESCE(s.order_type, '')) = 'INTERNE' THEN 'production_launch'
    WHEN s.canonical_status = 'PLANNING_VALIDE' THEN 'ar_preparation'
    WHEN s.canonical_status = 'AR_PRET' THEN 'ar_sent'
    WHEN s.canonical_status = 'AR_ENVOYE' THEN 'production_launch'
    WHEN s.canonical_status = 'EN_PRODUCTION' THEN 'production_completion'
    WHEN s.canonical_status IN ('PRODUCTION_TERMINEE','CONTROLE_QUALITE') THEN 'quality_control'
    WHEN s.canonical_status = 'PRET_LIVRAISON' THEN 'delivery'
    WHEN s.canonical_status = 'LIVRE' AND upper(COALESCE(s.order_type, '')) = 'INTERNE' THEN 'archive'
    WHEN s.canonical_status = 'LIVRE' THEN 'invoicing'
    WHEN s.canonical_status = 'FACTURE' THEN 'archive'
    ELSE NULL
  END AS expected_active_code
FROM state s
LEFT JOIN checkpoint_state cp ON cp.commande_id = s.commande_id
WHERE COALESCE(cp.checkpoint_count, 0) = 0
   OR cp.controlling_count > 1
   OR (s.canonical_status = 'BLOQUE' AND (cp.blocked_count <> 1 OR cp.resumable_blocked_count <> 1))
   OR (s.canonical_status <> 'BLOQUE' AND cp.blocked_count <> 0)
   OR (
     s.canonical_status NOT IN ('BLOQUE','ARCHIVE')
     AND (
       cp.controlling_count <> 1
       OR cp.active_code IS DISTINCT FROM CASE
         WHEN s.canonical_status = 'BROUILLON' THEN 'order_intake'
         WHEN s.canonical_status = 'EN_ANALYSE' THEN 'commercial_review'
         WHEN s.canonical_status = 'ATTENTE_TECHNIQUE' THEN 'technical_analysis'
         WHEN s.canonical_status = 'ATTENTE_STOCK' THEN 'stock_check'
         WHEN s.canonical_status = 'ATTENTE_OF' THEN 'of_generation'
         WHEN s.canonical_status = 'ATTENTE_PLANNING' THEN 'planning_validation'
         WHEN s.canonical_status = 'PLANNING_VALIDE' AND upper(COALESCE(s.order_type, '')) = 'INTERNE' THEN 'production_launch'
         WHEN s.canonical_status = 'PLANNING_VALIDE' THEN 'ar_preparation'
         WHEN s.canonical_status = 'AR_PRET' THEN 'ar_sent'
         WHEN s.canonical_status = 'AR_ENVOYE' THEN 'production_launch'
         WHEN s.canonical_status = 'EN_PRODUCTION' THEN 'production_completion'
         WHEN s.canonical_status IN ('PRODUCTION_TERMINEE','CONTROLE_QUALITE') THEN 'quality_control'
         WHEN s.canonical_status = 'PRET_LIVRAISON' THEN 'delivery'
         WHEN s.canonical_status = 'LIVRE' AND upper(COALESCE(s.order_type, '')) = 'INTERNE' THEN 'archive'
         WHEN s.canonical_status = 'LIVRE' THEN 'invoicing'
         WHEN s.canonical_status = 'FACTURE' THEN 'archive'
       END
     )
   )
   OR (s.canonical_status = 'ARCHIVE' AND cp.controlling_count <> 0)
ORDER BY s.commande_id
LIMIT 100;

ROLLBACK;
