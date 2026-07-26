-- 20260726_shopfloor_station_159.sql
-- Issue #159 (backend) / crp-systems-web#289 — Poste opérateur tablette
-- « CERP Atelier — Mon poste » : registre d'appareils de production, sessions
-- opérateur de poste, identification par badge pseudonymisée, journal d'audit
-- append-only et transmission de poste immuable.
--
-- Propriétés du patch :
--   * ADDITIF uniquement : aucune table existante n'est remplacée, aucune ligne
--     réécrite, aucun enum historique modifié. Les seules altérations portent
--     sur des tables CRÉÉES PAR CE PATCH.
--   * IDEMPOTENT : rejouable sans effet de bord.
--   * TRANSACTIONNEL : BEGIN/COMMIT, rien de partiel.
--   * INACTIF sur le métier : ne crée aucun appareil, aucune session, aucun
--     pointage, aucune quantité, aucun mouvement de stock, aucune donnée RH.
--   * Réversible : `support/20260726_shopfloor_station_159.rollback.sql`
--     (refuse de s'exécuter si des données réelles existent).
--
-- FRONTIÈRES D'ARCHITECTURE (ADR-0029) :
--   1. Le MOTEUR D'EXÉCUTION reste `production_pointages` (#274 / ADR-0027).
--      Ce patch n'ajoute AUCUNE table de temps, AUCUNE table de quantité et
--      AUCUN second moteur. Une session de poste n'est pas un segment.
--   2. Le module RH #119 (`hr_time_clock_devices`, `hr_badge_credentials`,
--      `hr_time_events`) n'est ni lu, ni écrit, ni étendu par ce patch. Les
--      tables créées ici sont volontairement SÉPARÉES : une tablette d'atelier
--      n'est pas une badgeuse, et une session de poste n'est pas une présence.
--      Le motif technique (hachage du support, statut d'appareil) est réutilisé,
--      les données ne le sont pas.
--   3. Aucune écriture de stock, lot, réservation, réception, BL ou facture.
--
-- Jamais exécuté en production par ce patch : application sur cerp_test, puis
-- cerp_prod uniquement sur autorisation humaine explicite.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 0) Pré-requis                                                              */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regclass('public.machines') IS NULL THEN
    RAISE EXCEPTION '#159 requires public.machines (2026-02-12_production_of_machines_postes.sql)';
  END IF;
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION '#159 requires public.users';
  END IF;
  IF to_regclass('public.ordres_fabrication') IS NULL THEN
    RAISE EXCEPTION '#159 requires public.ordres_fabrication';
  END IF;
  IF to_regclass('public.of_operations') IS NULL THEN
    RAISE EXCEPTION '#159 requires public.of_operations';
  END IF;
  -- Le poste opérateur PILOTE le moteur #274 : sans lui, l'écran n'a rien à
  -- commander et le patch n'a aucun sens.
  IF to_regclass('public.production_pointages') IS NULL THEN
    RAISE EXCEPTION '#159 requires public.production_pointages (#274 / ADR-0027)';
  END IF;
END$$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

/* -------------------------------------------------------------------------- */
/* 1) Registre des appareils de production                                    */
/* -------------------------------------------------------------------------- */
-- Une tablette d'atelier. Elle IDENTIFIE un poste physique ; elle n'AUTHENTIFIE
-- personne. Toute action privilégiée reste portée par la session opérateur.
--
-- `public_code` est généré par le serveur (TAB-0001…) et sert d'étiquette
-- lisible collée sur la tablette. Il n'est pas un secret : le connaître ne donne
-- aucun droit.
--
-- `enrollment_secret_hash` stocke une EMPREINTE HMAC-SHA-256, jamais le secret.
-- Il prépare une attestation d'appareil ultérieure ; il n'est pas exigé par le
-- lot courant, où l'autorisation vient exclusivement de la session utilisateur.

CREATE TABLE IF NOT EXISTS public.production_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_code text NOT NULL,
  label text NOT NULL,
  site text NULL,
  workshop_zone text NULL,

  -- FIXED : la tablette est vissée devant une machine et ne la choisit pas.
  -- MOBILE : l'opérateur confirme une machine autorisée à chaque session.
  assignment_mode text NOT NULL DEFAULT 'MOBILE',
  machine_id uuid NULL REFERENCES public.machines(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  status text NOT NULL DEFAULT 'ACTIVE',

  enrollment_secret_hash text NULL,
  enrollment_secret_version integer NOT NULL DEFAULT 1,

  -- Verrouillage automatique : une tablette d'atelier reste rarement surveillée.
  auto_lock_seconds integer NOT NULL DEFAULT 180,
  session_max_seconds integer NOT NULL DEFAULT 28800,

  last_seen_at timestamptz NULL,
  last_seen_app_version text NULL,

  enrolled_at timestamptz NOT NULL DEFAULT now(),
  enrolled_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  revoked_at timestamptz NULL,
  revoked_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  revoke_reason text NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  CONSTRAINT production_devices_public_code_159_uq UNIQUE (public_code),
  CONSTRAINT production_devices_public_code_159_ck
    CHECK (public_code ~ '^[A-Z][A-Z0-9-]{2,31}$'),
  CONSTRAINT production_devices_mode_159_ck
    CHECK (assignment_mode IN ('FIXED', 'MOBILE')),
  CONSTRAINT production_devices_status_159_ck
    CHECK (status IN ('ACTIVE', 'DISABLED', 'REVOKED')),
  -- Une tablette « fixe » sans machine ne serait fixe que de nom.
  CONSTRAINT production_devices_fixed_machine_159_ck
    CHECK (assignment_mode <> 'FIXED' OR machine_id IS NOT NULL),
  CONSTRAINT production_devices_revoked_159_ck
    CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL)),
  CONSTRAINT production_devices_autolock_159_ck
    CHECK (auto_lock_seconds BETWEEN 30 AND 3600),
  CONSTRAINT production_devices_session_max_159_ck
    CHECK (session_max_seconds BETWEEN 300 AND 86400),
  CONSTRAINT production_devices_secret_hash_159_ck
    CHECK (enrollment_secret_hash IS NULL OR enrollment_secret_hash ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS production_devices_status_159_idx
  ON public.production_devices (status)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS production_devices_machine_159_idx
  ON public.production_devices (machine_id)
  WHERE machine_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS production_devices_zone_159_idx
  ON public.production_devices (workshop_zone);

COMMENT ON TABLE public.production_devices IS
  '#159 — Tablettes et terminaux d''atelier. IDENTIFIE un poste, n''AUTHENTIFIE personne. Sans lien avec hr_time_clock_devices (#119).';

/* -------------------------------------------------------------------------- */
/* 2) Supports d'identification opérateur (badge / QR)                        */
/* -------------------------------------------------------------------------- */
-- Aucun UID de badge n'est stocké ni renvoyé en clair : seule une empreinte
-- HMAC-SHA-256 calculée avec un poivre serveur (`STATION_BADGE_PEPPER`) est
-- conservée. Perdre la base ne permet donc pas de cloner un badge sans le
-- poivre, et l'empreinte ne révèle pas le numéro gravé sur la carte.
--
-- Table SÉPARÉE de `hr_badge_credentials` (#119) : le même agent peut avoir un
-- badge RH et pas de support atelier, ou l'inverse. Fusionner les deux ferait
-- d'une action de production une donnée RH, ce que la séparation interdit.

CREATE TABLE IF NOT EXISTS public.operator_badge_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE CASCADE,

  credential_type text NOT NULL DEFAULT 'BADGE_NFC',
  credential_hash text NOT NULL,
  credential_version integer NOT NULL DEFAULT 1,
  label text NULL,

  active boolean NOT NULL DEFAULT true,
  issued_at timestamptz NOT NULL DEFAULT now(),
  issued_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  revoked_at timestamptz NULL,
  revoked_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  revoke_reason text NULL,

  last_used_at timestamptz NULL,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT operator_badge_credentials_hash_159_uq UNIQUE (credential_hash),
  CONSTRAINT operator_badge_credentials_hash_159_ck
    CHECK (credential_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT operator_badge_credentials_type_159_ck
    CHECK (credential_type IN ('BADGE_NFC', 'BADGE_RFID', 'QR')),
  CONSTRAINT operator_badge_credentials_active_159_ck
    CHECK ((revoked_at IS NULL) OR (active = false)),
  CONSTRAINT operator_badge_credentials_failed_159_ck
    CHECK (failed_attempts >= 0)
);

CREATE INDEX IF NOT EXISTS operator_badge_credentials_user_159_idx
  ON public.operator_badge_credentials (user_id)
  WHERE active;

COMMENT ON TABLE public.operator_badge_credentials IS
  '#159 — Supports d''identification atelier, pseudonymisés (HMAC-SHA-256 + poivre serveur). Aucun UID en clair. Distinct de hr_badge_credentials (#119).';

/* -------------------------------------------------------------------------- */
/* 3) Session opérateur de poste                                              */
/* -------------------------------------------------------------------------- */
-- CE N'EST PAS UN TEMPS DE PRÉSENCE RH. Ouvrir une session ne crée ni entrée,
-- ni sortie, ni pause, ni écriture de paie. Fermer une session n'arrête aucun
-- pointage de production : c'est une décision métier explicite, jamais un effet
-- de bord d'un verrouillage d'écran.
--
-- Le jeton de session est OPAQUE (aléatoire 32 octets) et seule son empreinte
-- SHA-256 est stockée. Conséquence recherchée : la révocation est immédiate et
-- côté serveur, ce qu'un JWT ne permet pas.

CREATE TABLE IF NOT EXISTS public.operator_device_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES public.production_devices(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  user_id integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  machine_id uuid NULL REFERENCES public.machines(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  identification_method text NOT NULL,
  session_token_hash text NOT NULL,

  state text NOT NULL DEFAULT 'ACTIVE',

  started_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  locked_at timestamptz NULL,
  closed_at timestamptz NULL,
  close_reason text NULL,

  handover_id uuid NULL,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  client_app_version text NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT operator_device_sessions_token_159_uq UNIQUE (session_token_hash),
  CONSTRAINT operator_device_sessions_token_159_ck
    CHECK (session_token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT operator_device_sessions_method_159_ck
    CHECK (identification_method IN ('BADGE', 'QR', 'PASSWORD', 'SSO')),
  CONSTRAINT operator_device_sessions_state_159_ck
    CHECK (state IN ('ACTIVE', 'LOCKED', 'CLOSED', 'EXPIRED', 'REVOKED')),
  CONSTRAINT operator_device_sessions_closed_159_ck
    CHECK ((state IN ('CLOSED', 'EXPIRED', 'REVOKED')) = (closed_at IS NOT NULL)),
  CONSTRAINT operator_device_sessions_locked_159_ck
    CHECK ((state = 'LOCKED') = (locked_at IS NOT NULL AND closed_at IS NULL))
);

-- Une seule session vivante par tablette : deux opérateurs ne partagent pas un
-- écran sans passer par une transmission de poste explicite.
CREATE UNIQUE INDEX IF NOT EXISTS operator_device_sessions_one_live_159_uq
  ON public.operator_device_sessions (device_id)
  WHERE state IN ('ACTIVE', 'LOCKED');

CREATE INDEX IF NOT EXISTS operator_device_sessions_user_159_idx
  ON public.operator_device_sessions (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS operator_device_sessions_machine_159_idx
  ON public.operator_device_sessions (machine_id)
  WHERE state IN ('ACTIVE', 'LOCKED');
CREATE INDEX IF NOT EXISTS operator_device_sessions_expiry_159_idx
  ON public.operator_device_sessions (expires_at)
  WHERE state IN ('ACTIVE', 'LOCKED');

COMMENT ON TABLE public.operator_device_sessions IS
  '#159 — Session opérateur sur tablette. N''EST PAS une présence RH (#119) et N''EST PAS un segment d''exécution (#274).';

/* -------------------------------------------------------------------------- */
/* 4) Journal d'audit de poste — append-only                                  */
/* -------------------------------------------------------------------------- */
-- Ce journal couvre l'APPAREIL et la SESSION. Il ne duplique pas
-- `production_pointage_events`, qui reste le journal du segment d'exécution.

CREATE TABLE IF NOT EXISTS public.station_audit_events (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  outcome text NOT NULL DEFAULT 'SUCCESS',
  reason_code text NULL,

  device_id uuid NULL REFERENCES public.production_devices(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  session_id uuid NULL REFERENCES public.operator_device_sessions(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  user_id integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  machine_id uuid NULL REFERENCES public.machines(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  of_id bigint NULL REFERENCES public.ordres_fabrication(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  operation_id uuid NULL REFERENCES public.of_operations(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  -- Contexte non nominatif et sans secret : jamais d'UID de badge, jamais de
  -- jeton, jamais de chemin de stockage.
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id uuid NULL,
  request_id text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT station_audit_events_outcome_159_ck
    CHECK (outcome IN ('SUCCESS', 'DENIED', 'ERROR')),
  CONSTRAINT station_audit_events_type_159_ck
    CHECK (event_type ~ '^[A-Z][A-Z0-9_]{2,63}$')
);

CREATE INDEX IF NOT EXISTS station_audit_events_device_159_idx
  ON public.station_audit_events (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS station_audit_events_user_159_idx
  ON public.station_audit_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS station_audit_events_type_159_idx
  ON public.station_audit_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS station_audit_events_denied_159_idx
  ON public.station_audit_events (created_at DESC)
  WHERE outcome = 'DENIED';

CREATE OR REPLACE FUNCTION public.fn_station_audit_append_only_159()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'station_audit_events is append-only (#159)'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_station_audit_append_only_159 ON public.station_audit_events;
CREATE TRIGGER trg_station_audit_append_only_159
  BEFORE UPDATE OR DELETE ON public.station_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_station_audit_append_only_159();

COMMENT ON TABLE public.station_audit_events IS
  '#159 — Journal append-only appareil/session. Ne duplique pas production_pointage_events (#274).';

/* -------------------------------------------------------------------------- */
/* 5) Transmission de poste — immuable                                        */
/* -------------------------------------------------------------------------- */
-- Une transmission raconte ce que l'opérateur sortant laisse derrière lui. Elle
-- ne modifie AUCUN temps déjà déclaré et n'écrit RIEN dans le domaine RH : elle
-- se contente d'être lue, accusée de réception et conservée.

CREATE TABLE IF NOT EXISTS public.production_shift_handovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  device_id uuid NULL REFERENCES public.production_devices(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  machine_id uuid NULL REFERENCES public.machines(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  of_id bigint NULL REFERENCES public.ordres_fabrication(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  operation_id uuid NULL REFERENCES public.of_operations(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  pointage_id uuid NULL REFERENCES public.production_pointages(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  outgoing_user_id integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  incoming_user_id integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  machine_state text NOT NULL DEFAULT 'RUNNING',
  qty_done numeric(18, 3) NULL,
  defects text NULL,
  tooling_left text NULL,
  remaining_actions text NULL,
  comment text NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  acknowledged_at timestamptz NULL,
  acknowledged_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  idempotency_key text NULL,

  CONSTRAINT production_shift_handovers_state_159_ck
    CHECK (machine_state IN ('RUNNING', 'STOPPED', 'SETUP', 'FAULT', 'MAINTENANCE', 'UNKNOWN')),
  -- Se transmettre le poste à soi-même n'est pas une transmission.
  CONSTRAINT production_shift_handovers_distinct_159_ck
    CHECK (outgoing_user_id <> incoming_user_id),
  CONSTRAINT production_shift_handovers_qty_159_ck
    CHECK (qty_done IS NULL OR qty_done >= 0),
  CONSTRAINT production_shift_handovers_ack_159_ck
    CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS production_shift_handovers_idem_159_uq
  ON public.production_shift_handovers (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS production_shift_handovers_incoming_159_idx
  ON public.production_shift_handovers (incoming_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS production_shift_handovers_machine_159_idx
  ON public.production_shift_handovers (machine_id, created_at DESC);
CREATE INDEX IF NOT EXISTS production_shift_handovers_pending_159_idx
  ON public.production_shift_handovers (incoming_user_id, created_at DESC)
  WHERE acknowledged_at IS NULL;

-- Immuabilité : seul l'accusé de lecture peut être posé, une seule fois.
CREATE OR REPLACE FUNCTION public.fn_shift_handover_immutable_159()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production_shift_handovers is immutable (#159)'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.acknowledged_at IS NOT NULL THEN
    RAISE EXCEPTION 'shift handover already acknowledged (#159)'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
       NEW.device_id, NEW.machine_id, NEW.of_id, NEW.operation_id, NEW.pointage_id,
       NEW.outgoing_user_id, NEW.incoming_user_id, NEW.machine_state, NEW.qty_done,
       NEW.defects, NEW.tooling_left, NEW.remaining_actions, NEW.comment,
       NEW.created_at, NEW.created_by, NEW.correlation_id, NEW.idempotency_key
     ) IS DISTINCT FROM ROW(
       OLD.device_id, OLD.machine_id, OLD.of_id, OLD.operation_id, OLD.pointage_id,
       OLD.outgoing_user_id, OLD.incoming_user_id, OLD.machine_state, OLD.qty_done,
       OLD.defects, OLD.tooling_left, OLD.remaining_actions, OLD.comment,
       OLD.created_at, OLD.created_by, OLD.correlation_id, OLD.idempotency_key
     ) THEN
    RAISE EXCEPTION 'only the acknowledgement can change on a shift handover (#159)'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shift_handover_immutable_159 ON public.production_shift_handovers;
CREATE TRIGGER trg_shift_handover_immutable_159
  BEFORE UPDATE OR DELETE ON public.production_shift_handovers
  FOR EACH ROW EXECUTE FUNCTION public.fn_shift_handover_immutable_159();

-- Le lien session → transmission est posé APRÈS création de la table cible.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operator_device_sessions_handover_159_fk'
      AND conrelid = 'public.operator_device_sessions'::regclass
  ) THEN
    ALTER TABLE public.operator_device_sessions
      ADD CONSTRAINT operator_device_sessions_handover_159_fk
      FOREIGN KEY (handover_id) REFERENCES public.production_shift_handovers(id)
      ON UPDATE RESTRICT ON DELETE SET NULL;
  END IF;
END$$;

COMMENT ON TABLE public.production_shift_handovers IS
  '#159 — Transmission de poste immuable. Ne modifie aucun temps déclaré et n''écrit rien dans le domaine RH (#119).';

/* -------------------------------------------------------------------------- */
/* 6) Générateur de code public d'appareil                                    */
/* -------------------------------------------------------------------------- */
-- Le code public est produit par la BASE, jamais par le navigateur : deux
-- enrôlements concurrents ne peuvent pas obtenir le même numéro.

CREATE SEQUENCE IF NOT EXISTS public.production_device_public_code_seq
  AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 NO MAXVALUE CACHE 1;

CREATE OR REPLACE FUNCTION public.fn_production_device_next_public_code(p_prefix text DEFAULT 'TAB')
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_prefix text := upper(coalesce(nullif(btrim(p_prefix), ''), 'TAB'));
  v_code text;
  v_guard integer := 0;
BEGIN
  IF v_prefix !~ '^[A-Z][A-Z0-9]{0,7}$' THEN
    RAISE EXCEPTION 'invalid device code prefix: %', p_prefix USING ERRCODE = '22023';
  END IF;

  LOOP
    v_guard := v_guard + 1;
    IF v_guard > 1000 THEN
      RAISE EXCEPTION 'unable to allocate a device public code (#159)' USING ERRCODE = '55000';
    END IF;

    v_code := v_prefix || '-' || lpad(nextval('public.production_device_public_code_seq')::text, 4, '0');

    -- Une base reprise d'un autre environnement peut déjà porter ce code : on
    -- avance plutôt que d'échouer.
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.production_devices WHERE public_code = v_code
    );
  END LOOP;

  RETURN v_code;
END;
$$;

/* -------------------------------------------------------------------------- */
/* 7) Horodatage de mise à jour                                               */
/* -------------------------------------------------------------------------- */

CREATE OR REPLACE FUNCTION public.fn_station_touch_updated_at_159()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_production_devices_touch_159 ON public.production_devices;
CREATE TRIGGER trg_production_devices_touch_159
  BEFORE UPDATE ON public.production_devices
  FOR EACH ROW EXECUTE FUNCTION public.fn_station_touch_updated_at_159();

DROP TRIGGER IF EXISTS trg_operator_badge_credentials_touch_159 ON public.operator_badge_credentials;
CREATE TRIGGER trg_operator_badge_credentials_touch_159
  BEFORE UPDATE ON public.operator_badge_credentials
  FOR EACH ROW EXECUTE FUNCTION public.fn_station_touch_updated_at_159();

/* -------------------------------------------------------------------------- */
/* 8) Vue de lecture — occupation des machines                                */
/* -------------------------------------------------------------------------- */
-- « Cette machine est-elle prise, et par qui ? » — question posée à chaque
-- confirmation de machine. La vue s'appuie sur le moteur #274 : elle ne
-- réinvente aucun état d'exécution.

CREATE OR REPLACE VIEW public.v_station_machine_occupancy AS
SELECT
  m.id                         AS machine_id,
  m.code                       AS machine_code,
  m.name                       AS machine_name,
  m.status                     AS machine_status,
  m.is_available               AS machine_is_available,
  m.workshop_zone              AS workshop_zone,
  p.id                         AS active_pointage_id,
  p.operator_user_id           AS active_operator_user_id,
  p.of_id                      AS active_of_id,
  p.operation_id               AS active_operation_id,
  p.activity_code              AS active_activity_code,
  p.start_ts                   AS active_since,
  s.id                         AS active_session_id,
  s.user_id                    AS active_session_user_id,
  d.id                         AS active_device_id,
  d.public_code                AS active_device_code
FROM public.machines m
LEFT JOIN LATERAL (
  SELECT pp.*
  FROM public.production_pointages pp
  WHERE pp.machine_id = m.id
    AND pp.status = 'RUNNING'
  ORDER BY pp.start_ts DESC
  LIMIT 1
) p ON true
LEFT JOIN LATERAL (
  SELECT os.*
  FROM public.operator_device_sessions os
  WHERE os.machine_id = m.id
    AND os.state IN ('ACTIVE', 'LOCKED')
  ORDER BY os.last_activity_at DESC
  LIMIT 1
) s ON true
LEFT JOIN public.production_devices d ON d.id = s.device_id
WHERE m.archived_at IS NULL;

COMMENT ON VIEW public.v_station_machine_occupancy IS
  '#159 — Occupation machine dérivée du moteur #274 et des sessions de poste. Aucun état d''exécution recalculé.';

/* -------------------------------------------------------------------------- */
/* 9) Droits runtime cerp_app                                                 */
/* -------------------------------------------------------------------------- */
-- Sans ces GRANT, un patch appliqué en peer auth `postgres` laisse le rôle
-- applicatif en 42501 et l'API renvoie 500 avec un schéma pourtant correct.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.production_devices TO cerp_app;
    GRANT SELECT, INSERT, UPDATE ON public.operator_badge_credentials TO cerp_app;
    GRANT SELECT, INSERT, UPDATE ON public.operator_device_sessions TO cerp_app;
    -- Journal append-only : lecture et insertion seulement, jamais UPDATE/DELETE.
    GRANT SELECT, INSERT ON public.station_audit_events TO cerp_app;
    GRANT SELECT, INSERT, UPDATE ON public.production_shift_handovers TO cerp_app;
    GRANT SELECT ON public.v_station_machine_occupancy TO cerp_app;
    GRANT USAGE, SELECT ON SEQUENCE public.station_audit_events_id_seq TO cerp_app;
    GRANT USAGE, SELECT ON SEQUENCE public.production_device_public_code_seq TO cerp_app;
    GRANT EXECUTE ON FUNCTION public.fn_production_device_next_public_code(text) TO cerp_app;
  END IF;
END$$;

-- Propriété : les objets créés en peer auth `postgres` appartiennent à
-- `postgres`, ce qui laisse `cerp_app` en 42501. On les réassigne au rôle
-- applicatif — SAUF `station_audit_events`.
--
-- `station_audit_events` reste délibérément propriété de `postgres`, comme
-- `erp_audit_logs` et `hr_time_events` : un propriétaire peut supprimer ses
-- propres triggers. Laisser `cerp_app` propriétaire d'un journal append-only
-- reviendrait à confier la serrure à celui qu'elle contraint.
DO $$
DECLARE
  v_obj text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RETURN;
  END IF;

  FOREACH v_obj IN ARRAY ARRAY[
    'public.production_devices',
    'public.operator_badge_credentials',
    'public.operator_device_sessions',
    'public.production_shift_handovers'
  ] LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO cerp_app', v_obj);
  END LOOP;

  EXECUTE 'ALTER SEQUENCE public.production_device_public_code_seq OWNER TO cerp_app';
  EXECUTE 'ALTER VIEW public.v_station_machine_occupancy OWNER TO cerp_app';
END$$;

COMMIT;
