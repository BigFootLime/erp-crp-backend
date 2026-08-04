-- Read-only verification for issue #314 / GPT56-CERP-0005.
-- Known historical aliases are accepted on read and projected below to their
-- canonical runtime value. No history row is rewritten by this release.
\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $$
BEGIN
  IF to_regclass('public.commande_client') IS NULL
     OR to_regclass('public.commande_historique') IS NULL
     OR to_regclass('public.commande_client_workflow_checkpoint') IS NULL
     OR to_regclass('public.commande_client_event_log') IS NULL THEN
    RAISE EXCEPTION '#314 verification failed: workflow prerequisites are missing';
  END IF;

  IF EXISTS (
    SELECT commande_id, checkpoint_code
    FROM public.commande_client_workflow_checkpoint
    GROUP BY commande_id, checkpoint_code
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION '#314 verification failed: duplicate command checkpoint codes exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'commande_historique'
      AND indexname = 'commande_historique_commande_last_idx'
  ) THEN
    RAISE EXCEPTION '#314 verification failed: latest-history lookup index is missing';
  END IF;

  IF EXISTS (
    SELECT commande_id
    FROM public.commande_client_workflow_checkpoint
    WHERE status IN ('active','blocked')
    GROUP BY commande_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION '#314 verification failed: a command has more than one active/blocked checkpoint';
  END IF;

  IF EXISTS (
    WITH latest AS (
      SELECT DISTINCT ON (commande_id) commande_id, nouveau_statut
      FROM public.commande_historique
      ORDER BY commande_id, date_action DESC, id DESC
    )
    SELECT 1
    FROM latest l
    LEFT JOIN public.commande_client_workflow_checkpoint cp
      ON cp.commande_id = l.commande_id AND cp.status = 'blocked'
    WHERE l.nouveau_statut = 'BLOQUE'
    GROUP BY l.commande_id
    HAVING COUNT(cp.id) <> 1
       OR COUNT(cp.id) FILTER (
         WHERE cp.metadata->>'previous_status_before_block' IN (
           'BROUILLON','EN_ANALYSE','ATTENTE_TECHNIQUE','ATTENTE_STOCK','ATTENTE_OF','ATTENTE_PLANNING',
           'PLANNING_VALIDE','AR_PRET','AR_ENVOYE','EN_PRODUCTION','PRODUCTION_TERMINEE','CONTROLE_QUALITE',
           'PRET_LIVRAISON','LIVRE','FACTURE'
         )
       ) <> 1
  ) THEN
    RAISE EXCEPTION '#314 verification failed: BLOQUE history lacks one resumable blocked checkpoint';
  END IF;

  IF EXISTS (
    WITH latest AS (
      SELECT DISTINCT ON (commande_id) commande_id,
        CASE nouveau_statut
          WHEN 'ENREGISTREE' THEN 'EN_ANALYSE'
          WHEN 'PLANIFIEE' THEN 'PLANNING_VALIDE'
          WHEN 'AR_ENVOYEE' THEN 'AR_ENVOYE'
          WHEN 'LIVREE' THEN 'LIVRE'
          ELSE nouveau_statut
        END AS canonical_status
      FROM public.commande_historique
      ORDER BY commande_id, date_action DESC, id DESC
    )
    SELECT 1
    FROM latest l
    JOIN public.commande_client_workflow_checkpoint cp ON cp.commande_id = l.commande_id
    WHERE l.canonical_status <> 'BLOQUE' AND cp.status = 'blocked'
  ) THEN
    RAISE EXCEPTION '#314 verification failed: non-BLOQUE history has a blocked checkpoint';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.commande_client cc
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.commande_client_workflow_checkpoint cp
      WHERE cp.commande_id = cc.id
    )
  ) THEN
    RAISE EXCEPTION '#314 verification failed: a command has no seeded checkpoints';
  END IF;

  -- Validate the whole ordered graph, not only the controlling checkpoint.
  -- This catches future checkpoints already done and enforces the two explicit
  -- skip paths (INTERNE and fully-reserved-from-stock).
  IF EXISTS (
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
          WHEN 'PLANNING_VALIDE' THEN CASE WHEN upper(COALESCE(es.order_type, '')) = 'INTERNE' THEN 9 ELSE 7 END
          WHEN 'AR_PRET' THEN 8 WHEN 'AR_ENVOYE' THEN 9
          WHEN 'EN_PRODUCTION' THEN 10
          WHEN 'PRODUCTION_TERMINEE' THEN 11 WHEN 'CONTROLE_QUALITE' THEN 11
          WHEN 'PRET_LIVRAISON' THEN 12
          WHEN 'LIVRE' THEN CASE WHEN upper(COALESCE(es.order_type, '')) = 'INTERNE' THEN 14 ELSE 13 END
          WHEN 'FACTURE' THEN 14 WHEN 'ARCHIVE' THEN 15
          ELSE NULL
        END AS active_position,
        upper(COALESCE(es.order_type, '')) = 'INTERNE'
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
    RAISE EXCEPTION '#314 verification failed: checkpoint graph is inconsistent with normalized history/order type';
  END IF;
END $$;

WITH latest AS (
  SELECT DISTINCT ON (commande_id) commande_id, nouveau_statut
  FROM public.commande_historique
  ORDER BY commande_id, date_action DESC, id DESC
), normalized AS (
  SELECT commande_id,
    CASE nouveau_statut
      WHEN 'ENREGISTREE' THEN 'EN_ANALYSE'
      WHEN 'PLANIFIEE' THEN 'PLANNING_VALIDE'
      WHEN 'AR_ENVOYEE' THEN 'AR_ENVOYE'
      WHEN 'LIVREE' THEN 'LIVRE'
      ELSE COALESCE(nouveau_statut, 'BROUILLON')
    END AS canonical_status
  FROM latest
)
SELECT canonical_status, COUNT(*) AS commandes
FROM normalized
GROUP BY canonical_status
ORDER BY canonical_status;

ROLLBACK;
