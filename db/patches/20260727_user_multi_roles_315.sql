-- Issue #315 — rôles multiples additifs pour un même compte CERP.
-- `users.role` reste le rôle principal de compatibilité pendant la transition.

BEGIN;

CREATE TABLE IF NOT EXISTS public.app_roles (
  role_key text PRIMARY KEY,
  category text NOT NULL CHECK (category IN ('PRIMARY', 'ORGANIZATION')),
  description text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_role_assignments (
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role_key text NOT NULL REFERENCES public.app_roles(role_key) ON UPDATE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, role_key)
);

CREATE INDEX IF NOT EXISTS idx_user_role_assignments_role
  ON public.user_role_assignments(role_key, user_id);

CREATE TABLE IF NOT EXISTS public.user_role_assignment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  role_key text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('ASSIGNED', 'REVOKED', 'MIGRATED')),
  actor_user_id integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'admin',
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_role_assignment_events_user
  ON public.user_role_assignment_events(user_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION public.fn_user_role_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'user_role_assignment_events is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_user_role_events_append_only
  ON public.user_role_assignment_events;
CREATE TRIGGER trg_user_role_events_append_only
BEFORE UPDATE OR DELETE ON public.user_role_assignment_events
FOR EACH ROW EXECUTE FUNCTION public.fn_user_role_events_append_only();

INSERT INTO public.app_roles (role_key, category, description)
VALUES
  ('Directeur', 'PRIMARY', 'Rôle principal de direction.'),
  ('Employee', 'PRIMARY', 'Rôle principal salarié sans privilège implicite.'),
  ('Administrateur Systeme et Reseau', 'PRIMARY', 'Administration technique CERP.'),
  ('Responsable Qualité', 'PRIMARY', 'Responsabilité qualité principale.'),
  ('Secretaire', 'PRIMARY', 'Secrétariat et assistance administrative.'),
  ('Responsable Programmation', 'PRIMARY', 'Responsabilité programmation et données techniques.'),
  ('Responsable RH', 'PRIMARY', 'Responsabilité ressources humaines.'),
  ('Gérant', 'ORGANIZATION', 'Gérance de la société.'),
  ('Commerce', 'ORGANIZATION', 'Commerce, clients, devis et commandes.'),
  ('Achats', 'ORGANIZATION', 'Achats et fournisseurs.'),
  ('RH-Financier', 'ORGANIZATION', 'Ressources humaines et pilotage financier.'),
  ('Directeur Technique', 'ORGANIZATION', 'Direction technique de l’atelier.'),
  ('Responsable Atelier-Production', 'ORGANIZATION', 'Supervision atelier et production.'),
  ('Planning', 'ORGANIZATION', 'Pilotage du planning de production.'),
  ('Planification', 'ORGANIZATION', 'Planification des opérations.'),
  ('Préparateur commandes', 'ORGANIZATION', 'Préparation des commandes et expéditions.'),
  ('Assistante polyvalente', 'ORGANIZATION', 'Assistance administrative polyvalente.'),
  ('Assistante RH', 'ORGANIZATION', 'Assistance des ressources humaines.'),
  ('Maintenance', 'ORGANIZATION', 'Maintenance du parc machine.'),
  ('Responsable Agencement', 'ORGANIZATION', 'Responsabilité agencement.'),
  ('Qualité', 'ORGANIZATION', 'Contrôle et décisions qualité.'),
  ('Études-Méthodes', 'ORGANIZATION', 'Études, méthodes et données techniques.'),
  ('Programmation', 'ORGANIZATION', 'Programmation d’usinage.'),
  ('Fraisage', 'ORGANIZATION', 'Opérations de fraisage.'),
  ('Livraison', 'ORGANIZATION', 'Livraison et expédition.'),
  ('Préparation matière', 'ORGANIZATION', 'Préparation des matières.'),
  ('Finitions', 'ORGANIZATION', 'Opérations de finition.'),
  ('Gestion matière', 'ORGANIZATION', 'Gestion de la matière et du stock.'),
  ('Responsable CAO', 'ORGANIZATION', 'Responsabilité conception assistée par ordinateur.'),
  ('Responsable fabrication fraisage', 'ORGANIZATION', 'Supervision de la fabrication fraisage.'),
  ('Tournage', 'ORGANIZATION', 'Opérations de tournage.'),
  ('Responsable tournage', 'ORGANIZATION', 'Supervision de la fabrication tournage.'),
  ('Opérateur atelier', 'ORGANIZATION', 'Exécution des opérations au poste atelier.')
ON CONFLICT (role_key) DO UPDATE
SET
  category = EXCLUDED.category,
  description = EXCLUDED.description,
  is_active = true,
  updated_at = now();

INSERT INTO public.user_role_assignments (user_id, role_key)
SELECT u.id, u.role
FROM public.users u
JOIN public.app_roles r ON r.role_key = u.role
ON CONFLICT (user_id, role_key) DO NOTHING;

INSERT INTO public.user_role_assignment_events (
  user_id,
  role_key,
  event_type,
  actor_user_id,
  source
)
SELECT
  ura.user_id,
  ura.role_key,
  'MIGRATED',
  NULL,
  'migration-315'
FROM public.user_role_assignments ura
WHERE NOT EXISTS (
  SELECT 1
  FROM public.user_role_assignment_events event
  WHERE event.user_id = ura.user_id
    AND event.role_key = ura.role_key
    AND event.event_type = 'MIGRATED'
    AND event.source = 'migration-315'
);

-- Les patches sont appliqués par le rôle système `postgres`, tandis que l'API
-- s'exécute avec le rôle de moindre privilège `cerp_app`. PostgreSQL ne propage
-- pas automatiquement les droits des tables existantes vers les nouvelles
-- tables : accorder explicitement le minimum nécessaire évite un login 500
-- après migration, sans rendre le journal append-only modifiable.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT ON TABLE public.app_roles TO cerp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE public.user_role_assignments
      TO cerp_app;
    GRANT SELECT, INSERT
      ON TABLE public.user_role_assignment_events
      TO cerp_app;
  END IF;
END
$grants$;

COMMIT;
