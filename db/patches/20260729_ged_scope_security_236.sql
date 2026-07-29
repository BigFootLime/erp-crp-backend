-- GED #236 - permissions par classe et refus par défaut.
--
-- Additif uniquement. Ce patch ne modifie ni document, ni version, ni blob.
-- Il remplace la détection applicative par sous-chaîne par un référentiel SQL
-- explicite (rôle attribué, classe, capacité).

BEGIN;

CREATE TABLE IF NOT EXISTS public.ged_class_capabilities (
  class_key   text NOT NULL
    REFERENCES public.ged_document_classes(class_key) ON UPDATE CASCADE ON DELETE CASCADE,
  role_key    text NOT NULL CHECK (length(btrim(role_key)) > 0),
  capability  text NOT NULL CHECK (capability IN (
    'read', 'upload', 'update_metadata', 'checkout', 'checkin', 'submit',
    'approve', 'publish', 'obsolete', 'download', 'export', 'admin'
  )),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (class_key, role_key, capability)
);

COMMENT ON TABLE public.ged_class_capabilities IS
  'Permissions GED explicites par rôle réellement attribué et classe documentaire. Absence de ligne = refus.';

CREATE INDEX IF NOT EXISTS idx_ged_class_capabilities_role
  ON public.ged_class_capabilities(role_key, capability, class_key);

-- Administration technique : le rôle admin implique toutes les capacités,
-- mais reste borné à chaque classe. Une future classe RH pourra donc ne pas
-- recevoir cette ligne.
INSERT INTO public.ged_class_capabilities (class_key, role_key, capability)
SELECT c.class_key, 'Administrateur Systeme et Reseau', 'admin'
  FROM public.ged_document_classes c
 WHERE c.is_active
ON CONFLICT DO NOTHING;

-- Direction : consultation et export, sans droit implicite de validation.
INSERT INTO public.ged_class_capabilities (class_key, role_key, capability)
SELECT c.class_key, r.role_key, p.capability
  FROM public.ged_document_classes c
 CROSS JOIN (VALUES ('Directeur'), ('Gérant')) AS r(role_key)
 CROSS JOIN (VALUES ('read'), ('download'), ('export')) AS p(capability)
 WHERE c.is_active
ON CONFLICT DO NOTHING;

-- Technique / Méthodes.
INSERT INTO public.ged_class_capabilities (class_key, role_key, capability)
SELECT c.class_key, r.role_key, p.capability
  FROM public.ged_document_classes c
 CROSS JOIN (
   VALUES
     ('Directeur Technique'),
     ('Responsable Programmation'),
     ('Programmation'),
     ('Études-Méthodes'),
     ('Responsable CAO')
 ) AS r(role_key)
 CROSS JOIN (
   VALUES
     ('read'), ('upload'), ('update_metadata'), ('checkout'), ('checkin'),
     ('submit'), ('download'), ('export')
 ) AS p(capability)
 WHERE c.domain = 'TECHNIQUE' AND c.is_active
ON CONFLICT DO NOTHING;

INSERT INTO public.ged_class_capabilities (class_key, role_key, capability)
SELECT c.class_key, r.role_key, p.capability
  FROM public.ged_document_classes c
 CROSS JOIN (VALUES ('Directeur Technique'), ('Responsable Programmation')) AS r(role_key)
 CROSS JOIN (VALUES ('approve'), ('publish'), ('obsolete')) AS p(capability)
 WHERE c.domain = 'TECHNIQUE' AND c.is_active
ON CONFLICT DO NOTHING;

INSERT INTO public.ged_class_capabilities (class_key, role_key, capability)
SELECT c.class_key, r.role_key, p.capability
  FROM public.ged_document_classes c
 CROSS JOIN (
   VALUES
     ('Responsable Qualité'),
     ('Qualité'),
     ('Responsable Atelier-Production'),
     ('Responsable fabrication fraisage'),
     ('Responsable tournage')
 ) AS r(role_key)
 CROSS JOIN (VALUES ('read'), ('download')) AS p(capability)
 WHERE c.domain = 'TECHNIQUE' AND c.is_active
ON CONFLICT DO NOTHING;

-- Production : les opérateurs ne parcourent pas la technique. Ils peuvent
-- uniquement déposer les preuves de production prévues par leur classe.
INSERT INTO public.ged_class_capabilities (class_key, role_key, capability)
SELECT c.class_key, r.role_key, p.capability
  FROM public.ged_document_classes c
 CROSS JOIN (
   VALUES
     ('Directeur Technique'),
     ('Responsable Atelier-Production'),
     ('Responsable fabrication fraisage'),
     ('Responsable tournage')
 ) AS r(role_key)
 CROSS JOIN (
   VALUES
     ('read'), ('upload'), ('update_metadata'), ('submit'),
     ('download'), ('export')
 ) AS p(capability)
 WHERE c.domain = 'PRODUCTION' AND c.is_active
ON CONFLICT DO NOTHING;

INSERT INTO public.ged_class_capabilities (class_key, role_key, capability)
SELECT c.class_key, r.role_key, p.capability
  FROM public.ged_document_classes c
 CROSS JOIN (
   VALUES
     ('Opérateur atelier'),
     ('Fraisage'),
     ('Finitions'),
     ('Tournage')
 ) AS r(role_key)
 CROSS JOIN (VALUES ('read'), ('upload'), ('download')) AS p(capability)
 WHERE c.class_key = 'OF_PHOTO' AND c.is_active
ON CONFLICT DO NOTHING;

INSERT INTO public.ged_class_capabilities (class_key, role_key, capability)
SELECT c.class_key, r.role_key, p.capability
  FROM public.ged_document_classes c
 CROSS JOIN (VALUES ('Responsable Qualité'), ('Qualité')) AS r(role_key)
 CROSS JOIN (VALUES ('read'), ('download')) AS p(capability)
 WHERE c.domain = 'PRODUCTION' AND c.is_active
ON CONFLICT DO NOTHING;

-- Qualité.
INSERT INTO public.ged_class_capabilities (class_key, role_key, capability)
SELECT c.class_key, r.role_key, p.capability
  FROM public.ged_document_classes c
 CROSS JOIN (VALUES ('Responsable Qualité'), ('Qualité')) AS r(role_key)
 CROSS JOIN (
   VALUES
     ('read'), ('upload'), ('update_metadata'), ('submit'), ('approve'),
     ('publish'), ('obsolete'), ('download'), ('export')
 ) AS p(capability)
 WHERE c.domain = 'QUALITE' AND c.is_active
ON CONFLICT DO NOTHING;

INSERT INTO public.ged_class_capabilities (class_key, role_key, capability)
SELECT c.class_key, r.role_key, p.capability
  FROM public.ged_document_classes c
 CROSS JOIN (
   VALUES
     ('Directeur Technique'),
     ('Études-Méthodes'),
     ('Achats'),
     ('Maintenance')
 ) AS r(role_key)
 CROSS JOIN (VALUES ('read'), ('download')) AS p(capability)
 WHERE c.domain = 'QUALITE' AND c.is_active
ON CONFLICT DO NOTHING;

-- Commercial.
INSERT INTO public.ged_class_capabilities (class_key, role_key, capability)
SELECT c.class_key, r.role_key, p.capability
  FROM public.ged_document_classes c
 CROSS JOIN (
   VALUES
     ('Commerce'),
     ('Secretaire'),
     ('Assistante polyvalente')
 ) AS r(role_key)
 CROSS JOIN (
   VALUES ('read'), ('upload'), ('update_metadata'), ('submit'), ('download'), ('export')
 ) AS p(capability)
 WHERE c.domain = 'COMMERCIAL' AND c.is_active
ON CONFLICT DO NOTHING;

-- Achats, réception et certificats.
INSERT INTO public.ged_class_capabilities (class_key, role_key, capability)
SELECT c.class_key, 'Achats', p.capability
  FROM public.ged_document_classes c
 CROSS JOIN (
   VALUES
     ('read'), ('upload'), ('update_metadata'), ('submit'),
     ('approve'), ('publish'), ('download'), ('export')
 ) AS p(capability)
 WHERE c.domain = 'ACHATS' AND c.is_active
ON CONFLICT DO NOTHING;

INSERT INTO public.ged_class_capabilities (class_key, role_key, capability)
SELECT c.class_key, r.role_key, p.capability
  FROM public.ged_document_classes c
 CROSS JOIN (
   VALUES
     ('Préparateur commandes'),
     ('Préparation matière'),
     ('Gestion matière'),
     ('Livraison')
 ) AS r(role_key)
 CROSS JOIN (VALUES ('read'), ('upload'), ('download')) AS p(capability)
 WHERE c.class_key IN ('RECEPTION_DOC', 'CERTIF_MATIERE') AND c.is_active
ON CONFLICT DO NOTHING;

INSERT INTO public.ged_class_capabilities (class_key, role_key, capability)
SELECT c.class_key, r.role_key, p.capability
  FROM public.ged_document_classes c
 CROSS JOIN (VALUES ('Responsable Qualité'), ('Qualité')) AS r(role_key)
 CROSS JOIN (VALUES ('read'), ('download')) AS p(capability)
 WHERE c.domain = 'ACHATS' AND c.is_active
ON CONFLICT DO NOTHING;

-- Gouvernance et procédures.
INSERT INTO public.ged_class_capabilities (class_key, role_key, capability)
SELECT c.class_key, r.role_key, p.capability
  FROM public.ged_document_classes c
 CROSS JOIN (VALUES ('Responsable Qualité'), ('Qualité')) AS r(role_key)
 CROSS JOIN (
   VALUES
     ('read'), ('upload'), ('update_metadata'), ('submit'), ('approve'),
     ('publish'), ('obsolete'), ('download'), ('export')
 ) AS p(capability)
 WHERE c.domain = 'GOUVERNANCE' AND c.is_active
ON CONFLICT DO NOTHING;

INSERT INTO public.ged_class_capabilities (class_key, role_key, capability)
SELECT c.class_key, r.role_key, p.capability
  FROM public.ged_document_classes c
 CROSS JOIN (
   VALUES
     ('Directeur Technique'),
     ('Études-Méthodes'),
     ('Responsable Programmation')
 ) AS r(role_key)
 CROSS JOIN (VALUES ('read'), ('download')) AS p(capability)
 WHERE c.domain = 'GOUVERNANCE' AND c.is_active
ON CONFLICT DO NOTHING;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT ON TABLE public.ged_class_capabilities TO cerp_app;
  END IF;
END
$grants$;

COMMIT;
