-- 20260726_production_execution_274.sql
-- Issue #274 — Suivi et pointage de production 360 : consolidation des deux
-- moteurs de temps existants, référentiel d'activités gouverné, segments
-- immuables, déclarations de quantités en deltas et idempotence.
--
-- Propriétés du patch :
--   * ADDITIF uniquement : `production_pointages`, `production_pointage_events`
--     et `of_time_logs` sont ÉTENDUS, jamais remplacés. Aucun enum historique
--     n'est supprimé ni renuméroté, aucune ligne existante n'est réécrite.
--   * IDEMPOTENT : rejouable sans effet de bord.
--   * TRANSACTIONNEL : BEGIN/COMMIT, rien de partiel.
--   * INACTIF sur le métier : ne crée aucun pointage, aucune déclaration,
--     aucun mouvement de stock, aucune non-conformité. Seules les CATÉGORIES
--     d'activité (référentiel désactivable) sont semées.
--   * Réversible : `db/patches/support/20260726_production_execution_274.rollback.sql`
--     (restreint à cerp_test, refuse de s'exécuter sur des données réelles).
--
-- DÉCISION D'ARCHITECTURE (ADR-0027) : `production_pointages` devient la SOURCE
-- DE VÉRITÉ du temps de production. `of_time_logs` est conservé intact et
-- devient un miroir de compatibilité : chaque ligne écrite par l'adaptateur
-- porte désormais `pointage_id`, ce qui permet à la fonction de recalcul
-- d'exclure les lignes déjà comptées côté canonique. Une minute ne peut donc
-- jamais être comptée deux fois dans `of_operations.temps_total_real`.
--
-- Jamais exécuté en production par ce patch : application sur cerp_test, puis
-- cerp_prod uniquement sur autorisation humaine explicite.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 0) Pré-requis                                                              */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regclass('public.production_pointages') IS NULL THEN
    RAISE EXCEPTION '#274 requires public.production_pointages (20260213_production_pointages.sql)';
  END IF;
  IF to_regclass('public.production_pointage_events') IS NULL THEN
    RAISE EXCEPTION '#274 requires public.production_pointage_events';
  END IF;
  IF to_regclass('public.of_operations') IS NULL THEN
    RAISE EXCEPTION '#274 requires public.of_operations (2026-02-12_production_of_machines_postes.sql)';
  END IF;
  IF to_regclass('public.of_time_logs') IS NULL THEN
    RAISE EXCEPTION '#274 requires public.of_time_logs';
  END IF;
END$$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

/* -------------------------------------------------------------------------- */
/* 1) Référentiel d'activités — gouverné, daté, désactivable                  */
/* -------------------------------------------------------------------------- */
-- Le modèle de temps a DEUX dimensions indépendantes :
--   * la RESSOURCE mesurée (opérateur / machine / programmation) → conservée
--     telle quelle dans l'enum historique `production_pointage_time_type` ;
--   * l'ACTIVITÉ réalisée (réglage, production, attente matière, panne…) →
--     ce référentiel, administrable sans migration.
-- Chaque catégorie déclare si elle consomme du temps opérateur, du temps
-- machine, si elle est productive, si un motif est obligatoire, sa criticité
-- et ses conséquences aval. Aucune règle n'est codée en dur dans le service.

CREATE TABLE IF NOT EXISTS public.production_activity_categories (
  code text PRIMARY KEY,
  label text NOT NULL,
  description text NULL,

  -- Comptabilisation : une attente matière consomme du temps machine mais pas
  -- forcément du temps opérateur ; un arrêt planifié ne consomme ni l'un ni
  -- l'autre. Ces drapeaux pilotent les agrégats, jamais une règle implicite.
  counts_operator_time boolean NOT NULL DEFAULT true,
  counts_machine_time boolean NOT NULL DEFAULT true,
  is_productive boolean NOT NULL DEFAULT false,

  requires_reason boolean NOT NULL DEFAULT false,
  criticality text NOT NULL DEFAULT 'NORMAL',

  -- Conséquences aval déclaratives : le service les lit, il ne les invente pas.
  signals_planning boolean NOT NULL DEFAULT false,
  signals_maintenance boolean NOT NULL DEFAULT false,
  signals_quality boolean NOT NULL DEFAULT false,

  -- Compatibilité ascendante avec les DEUX moteurs historiques : une catégorie
  -- peut porter la valeur legacy correspondante afin qu'aucune donnée existante
  -- ne devienne orpheline et que l'adaptateur sache traduire dans les deux sens.
  legacy_time_type production_pointage_time_type NULL,
  legacy_of_time_log_type public.of_time_log_type NULL,

  -- Capacité RBAC exigée en plus de `declare_incident` (NULL = aucune).
  required_capability text NULL,

  sort_order integer NOT NULL DEFAULT 100,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  disabled_at timestamptz NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT production_activity_categories_code_chk
    CHECK (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  CONSTRAINT production_activity_categories_criticality_chk
    CHECK (criticality IN ('LOW', 'NORMAL', 'HIGH', 'CRITICAL'))
);

DROP TRIGGER IF EXISTS production_activity_categories_set_updated_at
  ON public.production_activity_categories;
CREATE TRIGGER production_activity_categories_set_updated_at
  BEFORE UPDATE ON public.production_activity_categories
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE INDEX IF NOT EXISTS production_activity_categories_active_idx
  ON public.production_activity_categories (sort_order)
  WHERE disabled_at IS NULL;

-- Semis du référentiel. `ON CONFLICT DO NOTHING` : rejouable, et un
-- administrateur qui a modifié une catégorie ne se la fait jamais écraser.
INSERT INTO public.production_activity_categories (
  code, label, counts_operator_time, counts_machine_time, is_productive,
  requires_reason, criticality, signals_planning, signals_maintenance,
  signals_quality, legacy_time_type, legacy_of_time_log_type, sort_order
) VALUES
  ('SETUP',            'Réglage',              true,  true,  false, false, 'NORMAL',  false, false, false, 'MACHINE',       'SETUP',       10),
  ('PRODUCTION',       'Production',           true,  true,  true,  false, 'NORMAL',  false, false, false, 'OPERATEUR',     'PRODUCTION',  20),
  ('PROGRAMMING',      'Programmation',        true,  false, false, false, 'NORMAL',  false, false, false, 'PROGRAMMATION', 'PROGRAMMING', 30),
  ('CONTROL',          'Contrôle',             true,  false, false, false, 'NORMAL',  false, false, true,  'OPERATEUR',     'CONTROL',     40),
  ('MAINTENANCE',      'Maintenance',          true,  true,  false, true,  'HIGH',    true,  true,  false, 'MACHINE',       'MAINTENANCE', 50),
  ('CLEANING',         'Nettoyage',            true,  true,  false, false, 'LOW',     false, false, false, 'OPERATEUR',     NULL,          60),
  ('TOOL_CHANGE',      'Changement d''outil',  true,  true,  false, false, 'NORMAL',  false, false, false, 'MACHINE',       'SETUP',       70),
  ('WAIT_MATERIAL',    'Attente matière',      false, true,  false, true,  'HIGH',    true,  false, false, 'MACHINE',       NULL,          80),
  ('WAIT_QUALITY',     'Attente qualité',      false, true,  false, true,  'HIGH',    true,  false, true,  'MACHINE',       NULL,          90),
  ('WAIT_PROGRAM',     'Attente programme',    false, true,  false, true,  'NORMAL',  true,  false, false, 'MACHINE',       NULL,         100),
  ('BREAKDOWN',        'Panne',                false, true,  false, true,  'CRITICAL',true,  true,  false, 'MACHINE',       'MAINTENANCE',110),
  ('PLANNED_STOP',     'Arrêt planifié',       false, false, false, true,  'LOW',     true,  false, false, 'MACHINE',       NULL,         120),
  ('UNPLANNED_STOP',   'Arrêt non planifié',   false, true,  false, true,  'CRITICAL',true,  true,  false, 'MACHINE',       NULL,         130),
  ('REWORK',           'Reprise / retouche',   true,  true,  false, true,  'HIGH',    false, false, true,  'OPERATEUR',     'PRODUCTION', 140),
  ('OTHER',            'Autre',                true,  false, false, true,  'NORMAL',  false, false, false, 'OPERATEUR',     NULL,         150)
ON CONFLICT (code) DO NOTHING;

/* -------------------------------------------------------------------------- */
/* 2) Extension du moteur canonique `production_pointages`                    */
/* -------------------------------------------------------------------------- */
-- Aucune colonne existante n'est modifiée. Les nouvelles colonnes sont
-- nullables ou dotées d'un défaut compatible avec l'historique : les pointages
-- déjà enregistrés restent valides et lisibles sans reprise de données.

ALTER TABLE public.production_pointages
  ADD COLUMN IF NOT EXISTS activity_code text NULL
    REFERENCES public.production_activity_categories(code)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Une exécution d'opération regroupe N segments immuables (START, PAUSE,
  -- changement de machine…). `session_id` les relie sans jamais réécrire un
  -- segment passé.
  ADD COLUMN IF NOT EXISTS session_id uuid NULL,
  ADD COLUMN IF NOT EXISTS previous_segment_id uuid NULL
    REFERENCES public.production_pointages(id)
    ON UPDATE RESTRICT ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS segment_index integer NOT NULL DEFAULT 1,
  -- Provenance : distingue un pointage saisi via la surface canonique d'un
  -- pointage créé par l'adaptateur de compatibilité `of_time_logs`.
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'CANONICAL',
  ADD COLUMN IF NOT EXISTS idempotency_key text NULL,
  ADD COLUMN IF NOT EXISTS correlation_id uuid NULL,
  -- Contexte technique figé au démarrage : la gamme peut être révisée pendant
  -- l'exécution, la déclaration doit rester lisible telle qu'elle a été faite.
  ADD COLUMN IF NOT EXISTS context_snapshot jsonb NULL,
  ADD COLUMN IF NOT EXISTS is_retroactive boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_for_other_reason text NULL,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS submitted_by integer NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS rejected_by integer NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'production_pointages_source_chk'
  ) THEN
    ALTER TABLE public.production_pointages
      ADD CONSTRAINT production_pointages_source_chk
      CHECK (source IN ('CANONICAL', 'LEGACY_TIME_LOG', 'RETROACTIVE', 'ADAPTER'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'production_pointages_rejection_pair_chk'
  ) THEN
    ALTER TABLE public.production_pointages
      ADD CONSTRAINT production_pointages_rejection_pair_chk
      CHECK ((rejected_at IS NULL) = (rejected_by IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'production_pointages_submission_pair_chk'
  ) THEN
    ALTER TABLE public.production_pointages
      ADD CONSTRAINT production_pointages_submission_pair_chk
      CHECK ((submitted_at IS NULL) = (submitted_by IS NULL));
  END IF;

  -- Un rejet doit être motivé : sans cela le rejet est une décision opaque.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'production_pointages_rejection_reason_chk'
  ) THEN
    ALTER TABLE public.production_pointages
      ADD CONSTRAINT production_pointages_rejection_reason_chk
      CHECK (rejected_at IS NULL OR rejection_reason IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'production_pointages_segment_index_chk'
  ) THEN
    ALTER TABLE public.production_pointages
      ADD CONSTRAINT production_pointages_segment_index_chk CHECK (segment_index >= 1);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS production_pointages_session_id_idx
  ON public.production_pointages (session_id)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS production_pointages_activity_code_idx
  ON public.production_pointages (activity_code);

CREATE INDEX IF NOT EXISTS production_pointages_validated_at_idx
  ON public.production_pointages (validated_at)
  WHERE validated_at IS NULL;

-- Idempotence forte : la même clé ne peut pas créer deux pointages.
CREATE UNIQUE INDEX IF NOT EXISTS production_pointages_idempotency_key_uniq
  ON public.production_pointages (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

/* --- Anti-chevauchement réel, garanti par la base ------------------------- */
-- L'index partiel historique `production_pointages_running_operator_uniq` ne
-- protège que les pointages EN COURS. Il ne dit rien des saisies manuelles ni
-- rétroactives, qui peuvent aujourd'hui se chevaucher librement. On ajoute une
-- contrainte d'exclusion sur les intervalles fermés, convention [début, fin) :
-- deux segments qui se touchent bout à bout ne se chevauchent donc pas.
--
-- La contrainte n'est posée que si les données existantes la respectent déjà :
-- ce patch ne doit jamais échouer sur une base réelle ni réécrire l'historique.
-- Si des chevauchements préexistent, ils sont signalés et la contrainte est
-- laissée de côté pour une reprise humaine explicite.
DO $$
DECLARE
  operator_conflicts bigint;
  machine_conflicts bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'production_pointages_operator_no_overlap'
  ) THEN
    SELECT count(*) INTO operator_conflicts
    FROM public.production_pointages a
    JOIN public.production_pointages b
      ON b.id <> a.id
     AND b.operator_user_id = a.operator_user_id
     AND b.status IN ('RUNNING', 'DONE')
     AND tstzrange(b.start_ts, COALESCE(b.end_ts, 'infinity'::timestamptz), '[)')
         && tstzrange(a.start_ts, COALESCE(a.end_ts, 'infinity'::timestamptz), '[)')
    WHERE a.status IN ('RUNNING', 'DONE');

    IF operator_conflicts = 0 THEN
      ALTER TABLE public.production_pointages
        ADD CONSTRAINT production_pointages_operator_no_overlap
        EXCLUDE USING gist (
          operator_user_id WITH =,
          tstzrange(start_ts, COALESCE(end_ts, 'infinity'::timestamptz), '[)') WITH &&
        )
        WHERE (status IN ('RUNNING', 'DONE'));
    ELSE
      RAISE NOTICE '#274: % chevauchement(s) opérateur préexistant(s) — contrainte d''exclusion non posée, reprise humaine requise', operator_conflicts;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'production_pointages_machine_no_overlap'
  ) THEN
    SELECT count(*) INTO machine_conflicts
    FROM public.production_pointages a
    JOIN public.production_pointages b
      ON b.id <> a.id
     AND b.machine_id = a.machine_id
     AND b.status IN ('RUNNING', 'DONE')
     AND tstzrange(b.start_ts, COALESCE(b.end_ts, 'infinity'::timestamptz), '[)')
         && tstzrange(a.start_ts, COALESCE(a.end_ts, 'infinity'::timestamptz), '[)')
    WHERE a.status IN ('RUNNING', 'DONE') AND a.machine_id IS NOT NULL;

    IF machine_conflicts = 0 THEN
      ALTER TABLE public.production_pointages
        ADD CONSTRAINT production_pointages_machine_no_overlap
        EXCLUDE USING gist (
          machine_id WITH =,
          tstzrange(start_ts, COALESCE(end_ts, 'infinity'::timestamptz), '[)') WITH &&
        )
        WHERE (status IN ('RUNNING', 'DONE') AND machine_id IS NOT NULL);
    ELSE
      RAISE NOTICE '#274: % chevauchement(s) machine préexistant(s) — contrainte d''exclusion non posée, reprise humaine requise', machine_conflicts;
    END IF;
  END IF;
END$$;

/* -------------------------------------------------------------------------- */
/* 3) Déclarations de quantités — deltas immuables                            */
/* -------------------------------------------------------------------------- */
-- L'opérateur déclare des ÉCARTS, jamais un cumul réécrit : un cumul écrasé
-- efface silencieusement la déclaration précédente et rend le rebut
-- indétectable. Les lignes ne sont jamais mises à jour ; une correction est une
-- ligne compensatoire liée à l'originale.

CREATE TABLE IF NOT EXISTS public.production_quantity_declarations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  pointage_id uuid NULL
    REFERENCES public.production_pointages(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  of_id bigint NOT NULL
    REFERENCES public.ordres_fabrication(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  operation_id uuid NULL
    REFERENCES public.of_operations(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  -- Deltas signés : positifs en déclaration, négatifs en compensation.
  qty_good numeric(14, 4) NOT NULL DEFAULT 0,
  qty_scrap numeric(14, 4) NOT NULL DEFAULT 0,
  qty_rework numeric(14, 4) NOT NULL DEFAULT 0,
  qty_pending_control numeric(14, 4) NOT NULL DEFAULT 0,
  unite text NULL,

  scrap_reason_code text NULL,
  rework_reason_code text NULL,
  note text NULL,

  -- Traçabilité aval : renseigné SI le service Qualité canonique a créé une NC.
  -- Le pointage ne crée jamais lui-même une non-conformité.
  non_conformity_id uuid NULL,

  -- Une déclaration annulée reste visible : on ne supprime pas une déclaration,
  -- on la compense.
  compensates_id uuid NULL
    REFERENCES public.production_quantity_declarations(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  compensation_reason text NULL,

  idempotency_key text NULL,
  correlation_id uuid NULL,

  declared_at timestamptz NOT NULL DEFAULT now(),
  declared_by integer NOT NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT production_quantity_declarations_finite_chk CHECK (
    qty_good = qty_good AND qty_scrap = qty_scrap
    AND qty_rework = qty_rework AND qty_pending_control = qty_pending_control
  ),
  -- Une déclaration vide n'a pas de sens et masquerait un bug applicatif.
  CONSTRAINT production_quantity_declarations_not_empty_chk CHECK (
    qty_good <> 0 OR qty_scrap <> 0 OR qty_rework <> 0 OR qty_pending_control <> 0
  ),
  -- Seule une compensation peut porter des valeurs négatives, et elle doit
  -- être motivée.
  CONSTRAINT production_quantity_declarations_sign_chk CHECK (
    compensates_id IS NOT NULL
    OR (qty_good >= 0 AND qty_scrap >= 0 AND qty_rework >= 0 AND qty_pending_control >= 0)
  ),
  CONSTRAINT production_quantity_declarations_compensation_reason_chk CHECK (
    compensates_id IS NULL OR compensation_reason IS NOT NULL
  ),
  -- Un rebut sans cause est un rebut perdu pour l'analyse.
  CONSTRAINT production_quantity_declarations_scrap_reason_chk CHECK (
    qty_scrap <= 0 OR scrap_reason_code IS NOT NULL
  ),
  CONSTRAINT production_quantity_declarations_rework_reason_chk CHECK (
    qty_rework <= 0 OR rework_reason_code IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS production_quantity_declarations_idempotency_key_uniq
  ON public.production_quantity_declarations (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Une déclaration ne peut être compensée qu'une seule fois.
CREATE UNIQUE INDEX IF NOT EXISTS production_quantity_declarations_compensates_uniq
  ON public.production_quantity_declarations (compensates_id)
  WHERE compensates_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS production_quantity_declarations_of_id_idx
  ON public.production_quantity_declarations (of_id);
CREATE INDEX IF NOT EXISTS production_quantity_declarations_operation_id_idx
  ON public.production_quantity_declarations (operation_id);
CREATE INDEX IF NOT EXISTS production_quantity_declarations_pointage_id_idx
  ON public.production_quantity_declarations (pointage_id);
CREATE INDEX IF NOT EXISTS production_quantity_declarations_declared_at_idx
  ON public.production_quantity_declarations (declared_at);

-- Append-only : une déclaration signée ne se réécrit pas. La compensation est
-- le seul mécanisme de correction, et elle laisse l'original visible.
CREATE OR REPLACE FUNCTION public.tg_production_quantity_declarations_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Seul le rattachement d'une NC créée a posteriori par le service Qualité
  -- canonique est toléré ; tout le reste est figé.
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*)
       AND (
         NEW.id IS DISTINCT FROM OLD.id
         OR NEW.pointage_id IS DISTINCT FROM OLD.pointage_id
         OR NEW.of_id IS DISTINCT FROM OLD.of_id
         OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
         OR NEW.qty_good IS DISTINCT FROM OLD.qty_good
         OR NEW.qty_scrap IS DISTINCT FROM OLD.qty_scrap
         OR NEW.qty_rework IS DISTINCT FROM OLD.qty_rework
         OR NEW.qty_pending_control IS DISTINCT FROM OLD.qty_pending_control
         OR NEW.declared_by IS DISTINCT FROM OLD.declared_by
         OR NEW.declared_at IS DISTINCT FROM OLD.declared_at
         OR NEW.compensates_id IS DISTINCT FROM OLD.compensates_id
       )
    THEN
      RAISE EXCEPTION 'production_quantity_declarations is append-only (id=%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS production_quantity_declarations_append_only
  ON public.production_quantity_declarations;
CREATE TRIGGER production_quantity_declarations_append_only
  BEFORE UPDATE OR DELETE ON public.production_quantity_declarations
  FOR EACH ROW EXECUTE FUNCTION public.tg_production_quantity_declarations_append_only();

/* -------------------------------------------------------------------------- */
/* 4) Idempotence des commandes à effet                                       */
/* -------------------------------------------------------------------------- */
-- Contrat : même clé + même empreinte de charge utile → même réponse rejouée.
-- Même clé + charge utile différente → 409. La table stocke l'empreinte, pas
-- la charge utile : aucune donnée personnelle n'y est recopiée.

CREATE TABLE IF NOT EXISTS public.production_execution_idempotency (
  idempotency_key text PRIMARY KEY,
  scope text NOT NULL,
  request_fingerprint text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NULL,
  user_id integer NOT NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT production_execution_idempotency_fingerprint_chk
    CHECK (char_length(request_fingerprint) = 64)
);

CREATE INDEX IF NOT EXISTS production_execution_idempotency_created_at_idx
  ON public.production_execution_idempotency (created_at);

/* -------------------------------------------------------------------------- */
/* 5) Compatibilité `of_time_logs` — corrélation, sans double comptage        */
/* -------------------------------------------------------------------------- */
-- `of_time_logs` n'est ni supprimé ni vidé : les écrans et tests historiques
-- continuent de fonctionner. On lui ajoute simplement le lien vers le pointage
-- canonique correspondant lorsque l'adaptateur a écrit les deux. Les lignes
-- historiques gardent `pointage_id IS NULL` et restent donc comptées comme
-- avant : aucune minute ne disparaît, aucune n'est comptée deux fois.

ALTER TABLE public.of_time_logs
  ADD COLUMN IF NOT EXISTS pointage_id uuid NULL
    REFERENCES public.production_pointages(id)
    ON UPDATE RESTRICT ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS of_time_logs_pointage_id_uniq
  ON public.of_time_logs (pointage_id)
  WHERE pointage_id IS NOT NULL;

-- Adaptateur transactionnel des routes historiques.
--
-- Les contrôleurs legacy continuent d'insérer/arrêter `of_time_logs`, donc leur
-- contrat HTTP et leur vue `open_time_log` restent inchangés. Le trigger crée
-- ou ferme le pointage canonique DANS LA MÊME TRANSACTION. Si l'une des deux
-- écritures échoue, PostgreSQL annule l'ensemble : aucun miroir orphelin, aucun
-- pointage invisible et aucun double comptage.
CREATE OR REPLACE FUNCTION public.tg_production_mirror_legacy_time_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pointage_id uuid;
  v_session_id uuid;
  v_of_id bigint;
  v_affaire_id bigint;
  v_piece_technique_id uuid;
  v_poste_id uuid;
  v_activity_code text;
  v_time_type production_pointage_time_type;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.pointage_id IS NULL THEN
    SELECT
      op.of_id,
      o.affaire_id,
      o.piece_technique_id,
      op.poste_id
    INTO
      v_of_id,
      v_affaire_id,
      v_piece_technique_id,
      v_poste_id
    FROM public.of_operations op
    JOIN public.ordres_fabrication o ON o.id = op.of_id
    WHERE op.id = NEW.of_operation_id;

    IF v_of_id IS NULL THEN
      RAISE EXCEPTION 'OF operation % not found for legacy time log', NEW.of_operation_id
        USING ERRCODE = '23503';
    END IF;

    v_activity_code := CASE NEW.type
      WHEN 'SETUP'       THEN 'SETUP'
      WHEN 'PROGRAMMING' THEN 'PROGRAMMING'
      WHEN 'CONTROL'     THEN 'CONTROL'
      WHEN 'MAINTENANCE' THEN 'MAINTENANCE'
      ELSE 'PRODUCTION'
    END;

    v_time_type := CASE NEW.type
      WHEN 'PROGRAMMING' THEN 'PROGRAMMATION'::production_pointage_time_type
      WHEN 'MAINTENANCE' THEN 'MACHINE'::production_pointage_time_type
      ELSE 'OPERATEUR'::production_pointage_time_type
    END;

    v_session_id := gen_random_uuid();

    INSERT INTO public.production_pointages (
      of_id,
      affaire_id,
      piece_technique_id,
      operation_id,
      machine_id,
      poste_id,
      operator_user_id,
      time_type,
      activity_code,
      start_ts,
      end_ts,
      status,
      comment,
      session_id,
      segment_index,
      source,
      context_snapshot,
      created_by,
      updated_by
    )
    VALUES (
      v_of_id,
      v_affaire_id,
      v_piece_technique_id,
      NEW.of_operation_id,
      NEW.machine_id,
      v_poste_id,
      NEW.user_id,
      v_time_type,
      v_activity_code,
      NEW.started_at,
      NEW.ended_at,
      CASE
        WHEN NEW.ended_at IS NULL THEN 'RUNNING'::production_pointage_status
        ELSE 'DONE'::production_pointage_status
      END,
      NEW.comment,
      v_session_id,
      1,
      'LEGACY_TIME_LOG',
      jsonb_build_object(
        'captured_at', now(),
        'operation_id', NEW.of_operation_id,
        'activity_code', v_activity_code,
        'legacy_time_log_type', NEW.type
      ),
      NEW.user_id,
      NEW.user_id
    )
    RETURNING id INTO v_pointage_id;

    NEW.pointage_id := v_pointage_id;

    INSERT INTO public.production_pointage_events (
      pointage_id,
      event_type,
      new_values,
      user_id,
      note
    )
    VALUES (
      v_pointage_id,
      'START',
      jsonb_build_object(
        'of_id', v_of_id,
        'operation_id', NEW.of_operation_id,
        'machine_id', NEW.machine_id,
        'activity_code', v_activity_code,
        'operator_user_id', NEW.user_id,
        'source', 'LEGACY_TIME_LOG'
      ),
      NEW.user_id,
      NEW.comment
    );

    IF NEW.ended_at IS NOT NULL THEN
      NEW.duration_minutes := GREATEST(
        0,
        ROUND(EXTRACT(EPOCH FROM (NEW.ended_at - NEW.started_at)) / 60.0)::int
      );

      INSERT INTO public.production_pointage_events (
        pointage_id,
        event_type,
        old_values,
        new_values,
        user_id,
        note
      )
      VALUES (
        v_pointage_id,
        'STOP',
        '{"status":"RUNNING"}'::jsonb,
        jsonb_build_object('status', 'DONE', 'duration_minutes', NEW.duration_minutes),
        NEW.user_id,
        NEW.comment
      );
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.pointage_id IS NOT NULL
     AND OLD.ended_at IS NULL
     AND NEW.ended_at IS NOT NULL THEN
    NEW.duration_minutes := GREATEST(
      0,
      ROUND(EXTRACT(EPOCH FROM (NEW.ended_at - NEW.started_at)) / 60.0)::int
    );

    UPDATE public.production_pointages
    SET
      status = 'DONE'::production_pointage_status,
      end_ts = NEW.ended_at,
      comment = COALESCE(NEW.comment, comment),
      updated_at = now(),
      updated_by = NEW.user_id
    WHERE id = NEW.pointage_id
      AND status = 'RUNNING';

    IF FOUND THEN
      INSERT INTO public.production_pointage_events (
        pointage_id,
        event_type,
        old_values,
        new_values,
        user_id,
        note
      )
      VALUES (
        NEW.pointage_id,
        'STOP',
        '{"status":"RUNNING"}'::jsonb,
        jsonb_build_object('status', 'DONE', 'duration_minutes', NEW.duration_minutes),
        NEW.user_id,
        NEW.comment
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS production_mirror_legacy_time_log
  ON public.of_time_logs;
CREATE TRIGGER production_mirror_legacy_time_log
  BEFORE INSERT OR UPDATE OF ended_at, comment
  ON public.of_time_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_production_mirror_legacy_time_log();

/* -------------------------------------------------------------------------- */
/* 6) Recalcul unique et autoritaire de `of_operations.temps_total_real`      */
/* -------------------------------------------------------------------------- */
-- UNE seule formule, appelée par les deux surfaces. `temps_total_real` reste
-- exprimé en HEURES, numeric(12,3), comme depuis 2026-02-12 : aucune unité
-- n'est changée sous les pieds des consommateurs (planning, coûts, exports).
--
-- Total = temps canonique (production_pointages)
--       + temps legacy NON migré (of_time_logs sans pointage_id)
--
-- Les statuts CANCELLED et CORRECTED sont exclus : une saisie annulée ou
-- remplacée ne doit pas gonfler le temps réel, tout en restant visible en
-- historique. Seules les catégories qui déclarent `counts_operator_time`
-- comptent ; un arrêt planifié n'est pas du temps consommé par l'opération.
-- Une catégorie absente (pointage historique) compte, pour ne pas faire
-- disparaître rétroactivement du temps déjà déclaré.

CREATE OR REPLACE FUNCTION public.fn_production_operation_real_hours(p_operation_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT ROUND(
    (
      COALESCE((
        SELECT SUM(p.duration_minutes)
        FROM public.production_pointages p
        LEFT JOIN public.production_activity_categories c ON c.code = p.activity_code
        WHERE p.operation_id = p_operation_id
          AND p.duration_minutes IS NOT NULL
          AND p.status IN ('DONE')
          AND COALESCE(c.counts_operator_time, true)
      ), 0)
      +
      COALESCE((
        SELECT SUM(t.duration_minutes)
        FROM public.of_time_logs t
        WHERE t.of_operation_id = p_operation_id
          AND t.duration_minutes IS NOT NULL
          AND t.pointage_id IS NULL
      ), 0)
    )::numeric / 60.0,
    3
  );
$$;

COMMENT ON FUNCTION public.fn_production_operation_real_hours(uuid) IS
  '#274 — Source unique du temps réel d''une opération d''OF, en heures. Somme le moteur canonique (production_pointages, statut DONE, catégories comptabilisées) et le résidu legacy non migré (of_time_logs sans pointage_id). Garantit qu''une minute n''est jamais comptée deux fois.';

CREATE OR REPLACE FUNCTION public.fn_production_recompute_operation_real_time(p_operation_id uuid)
RETURNS numeric
LANGUAGE plpgsql
AS $$
DECLARE
  v_hours numeric;
BEGIN
  v_hours := public.fn_production_operation_real_hours(p_operation_id);

  UPDATE public.of_operations
  SET temps_total_real = v_hours,
      updated_at = now()
  WHERE id = p_operation_id;

  RETURN v_hours;
END;
$$;

COMMENT ON FUNCTION public.fn_production_recompute_operation_real_time(uuid) IS
  '#274 — Recalcule et persiste of_operations.temps_total_real depuis la source unique. Idempotent : recalcul complet, jamais incrémental.';

/* -------------------------------------------------------------------------- */
/* 7) Vue de lecture : exécution en cours (Planning / Command Center Machines) */
/* -------------------------------------------------------------------------- */
-- Read-model unique de « ce qui tourne réellement ». Les consommateurs cessent
-- d'interroger deux tables aux sémantiques différentes.

CREATE OR REPLACE VIEW public.v_production_active_executions AS
SELECT
  p.id                     AS pointage_id,
  p.session_id,
  p.of_id,
  o.numero                 AS of_numero,
  p.operation_id,
  op.phase                 AS operation_phase,
  op.designation           AS operation_designation,
  p.machine_id,
  p.poste_id,
  p.operator_user_id,
  p.time_type,
  p.activity_code,
  COALESCE(c.label, p.time_type::text) AS activity_label,
  COALESCE(c.is_productive, false)     AS activity_is_productive,
  COALESCE(c.criticality, 'NORMAL')    AS activity_criticality,
  p.start_ts,
  -- Durée écoulée calculée par la base : le navigateur n'est jamais la source
  -- du temps officiel.
  GREATEST(0, ROUND(EXTRACT(EPOCH FROM (now() - p.start_ts)) / 60.0)::int) AS elapsed_minutes,
  op.temps_total_planned,
  op.temps_total_real
FROM public.production_pointages p
JOIN public.ordres_fabrication o ON o.id = p.of_id
LEFT JOIN public.of_operations op ON op.id = p.operation_id
LEFT JOIN public.production_activity_categories c ON c.code = p.activity_code
WHERE p.status = 'RUNNING';

COMMENT ON VIEW public.v_production_active_executions IS
  '#274 — Read-model autoritaire des exécutions en cours (Planning, Command Center Machines, poste opérateur).';

/* -------------------------------------------------------------------------- */
/* 8) Commentaires de traçabilité                                             */
/* -------------------------------------------------------------------------- */

COMMENT ON TABLE public.production_activity_categories IS
  '#274 — Référentiel gouverné des activités de production (réglage, production, attentes, arrêts, reprise). Daté et désactivable, il évite un second enum incompatible.';
COMMENT ON TABLE public.production_quantity_declarations IS
  '#274 — Déclarations de quantités en deltas immuables (bonnes, rebut, reprise, attente contrôle). Append-only : une correction est une ligne compensatoire.';
COMMENT ON TABLE public.production_execution_idempotency IS
  '#274 — Rejeu idempotent des commandes à effet du suivi de production. Stocke une empreinte, jamais la charge utile.';
COMMENT ON COLUMN public.of_time_logs.pointage_id IS
  '#274 — Corrélation vers le pointage canonique. NULL = ligne historique, comptée comme avant. Non NULL = déjà comptée côté canonique, exclue du total pour éviter le double comptage.';

/* -------------------------------------------------------------------------- */
/* 9) Privilèges runtime minimaux                                             */
/* -------------------------------------------------------------------------- */
-- Les migrations sont généralement appliquées par `postgres`, alors que l'API
-- s'exécute avec `cerp_app`. Sans ces droits explicites, un patch valide en
-- recette échouerait au premier appel runtime.
REVOKE ALL ON FUNCTION public.tg_production_mirror_legacy_time_log() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_production_operation_real_hours(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_production_recompute_operation_real_time(uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE
      ON public.production_pointages
      TO cerp_app;
    GRANT SELECT, INSERT
      ON public.production_pointage_events
      TO cerp_app;
    GRANT SELECT
      ON public.production_activity_categories
      TO cerp_app;
    GRANT SELECT, INSERT
      ON public.production_quantity_declarations
      TO cerp_app;
    GRANT SELECT, INSERT, UPDATE
      ON public.production_execution_idempotency
      TO cerp_app;
    GRANT SELECT, INSERT, UPDATE
      ON public.of_time_logs
      TO cerp_app;
    GRANT SELECT
      ON public.v_production_active_executions
      TO cerp_app;
    GRANT USAGE, SELECT
      ON SEQUENCE public.production_pointage_events_id_seq
      TO cerp_app;
    GRANT EXECUTE
      ON FUNCTION public.fn_production_operation_real_hours(uuid),
                  public.fn_production_recompute_operation_real_time(uuid)
      TO cerp_app;
  END IF;
END$$;

COMMIT;
