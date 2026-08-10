-- SOL-05 only: minimum historical schema needed to replay the additive patch chain.
-- This file must never be executed against a persistent or production database.

BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'cerp_test'
     OR current_setting('cerp.e2e_isolated', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'SOL-05 bootstrap refused: expected isolated cerp_test with cerp.e2e_isolated=on';
  END IF;
END
$guard$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    CREATE ROLE cerp_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres NOLOGIN;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;

CREATE TABLE public.users (
  id serial PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password text NOT NULL,
  name text NOT NULL DEFAULT '',
  surname text NOT NULL DEFAULT '',
  email text UNIQUE,
  tel_no text,
  role text NOT NULL DEFAULT 'Employee',
  gender text,
  address text,
  lane text,
  house_no text,
  postcode text,
  country text,
  salary numeric,
  date_of_birth date,
  employment_date date,
  employment_end_date date,
  national_id text,
  status text NOT NULL DEFAULT 'Active',
  social_security_number text
);

CREATE TABLE public.auth_login_logs (
  id bigserial PRIMARY KEY,
  user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
  username_attempt text NOT NULL,
  success boolean NOT NULL,
  failure_reason text,
  ip text,
  user_agent text,
  device_type text,
  os text,
  browser text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_login_logs_created_at_idx ON public.auth_login_logs (created_at DESC);

-- Deterministic test-only bootstrap identity. The seed replaces this hash from
-- the public E2E password constant after every migration replay.
INSERT INTO public.users (username, password, name, surname, email, role, status)
VALUES (
  'KEENAN',
  '$2b$10$XC1ALzx87ByGpOq8qsQYqOD0IS72VnipgjC6Cdi8K17Cl9T881UtS',
  'Keenan',
  'E2E',
  'keenan.e2e@invalid.example',
  'Administrateur Systeme et Reseau',
  'Active'
);

CREATE TABLE public.adresse_livraison (
  delivery_address_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address text,
  postal_code text,
  city text,
  country text
);

CREATE TABLE public.contacts (
  contact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar(3),
  first_name text,
  last_name text,
  civility text,
  role text,
  phone_direct text,
  phone_personal text,
  email text,
  archived_at timestamptz
);

-- The client repository intentionally lets PostgreSQL allocate the immutable
-- legacy key.  Model that historical database contract explicitly so a fresh
-- isolated database can exercise real client creation.
CREATE SEQUENCE public.clients_client_id_seq AS integer MINVALUE 1 MAXVALUE 999;

CREATE TABLE public.clients (
  client_id varchar(3) PRIMARY KEY
    DEFAULT lpad(nextval('public.clients_client_id_seq')::text, 3, '0'),
  company_name text NOT NULL,
  email text,
  phone text,
  address text,
  city text,
  postal_code text,
  country text,
  status text NOT NULL DEFAULT 'client',
  siret text,
  code_naf text,
  tva_intracom text,
  date_creation timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  creation_date timestamptz NOT NULL DEFAULT now(),
  delivery_address_id uuid REFERENCES public.adresse_livraison(delivery_address_id),
  contact_id uuid REFERENCES public.contacts(contact_id)
);
ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(client_id);

CREATE TABLE public.documents_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar(3) REFERENCES public.clients(client_id),
  document_name text NOT NULL DEFAULT '',
  document_path text,
  type text,
  creation_date timestamptz NOT NULL DEFAULT now(),
  created_by integer REFERENCES public.users(id)
);

CREATE TABLE public.devis (
  id bigserial PRIMARY KEY,
  numero text UNIQUE,
  client_id varchar(3) REFERENCES public.clients(client_id),
  contact_id uuid REFERENCES public.contacts(contact_id),
  statut text NOT NULL DEFAULT 'BROUILLON',
  date_creation date NOT NULL DEFAULT CURRENT_DATE,
  date_validite date,
  objet text,
  total_ht numeric(18,2) NOT NULL DEFAULT 0,
  total_ttc numeric(18,2) NOT NULL DEFAULT 0,
  remise_globale numeric(8,4) NOT NULL DEFAULT 0,
  commentaires text,
  user_id integer REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.devis_ligne (
  id bigserial PRIMARY KEY,
  devis_id bigint NOT NULL REFERENCES public.devis(id) ON DELETE CASCADE,
  ordre integer NOT NULL DEFAULT 1,
  designation text NOT NULL DEFAULT '',
  code_piece text,
  quantite numeric(18,6) NOT NULL DEFAULT 1,
  unite text,
  delai_client date,
  prix_unitaire_ht numeric(18,4) NOT NULL DEFAULT 0,
  remise_ligne numeric(8,4) NOT NULL DEFAULT 0,
  taux_tva numeric(8,4) NOT NULL DEFAULT 20,
  total_ht numeric(18,2) NOT NULL DEFAULT 0,
  total_ttc numeric(18,2) NOT NULL DEFAULT 0
);

CREATE TABLE public.devis_documents (
  id bigserial PRIMARY KEY,
  devis_id bigint NOT NULL REFERENCES public.devis(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents_clients(id) ON DELETE RESTRICT,
  type text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.commande_client (
  id bigserial PRIMARY KEY,
  numero text NOT NULL UNIQUE,
  client_id varchar(3) NOT NULL REFERENCES public.clients(client_id),
  devis_id bigint REFERENCES public.devis(id),
  contact_id uuid REFERENCES public.contacts(contact_id),
  statut text NOT NULL DEFAULT 'BROUILLON',
  type_affaire text NOT NULL DEFAULT 'livraison',
  date_commande date NOT NULL DEFAULT CURRENT_DATE,
  date_livraison_prevue date,
  total_ht numeric(18,2) NOT NULL DEFAULT 0,
  total_ttc numeric(18,2) NOT NULL DEFAULT 0,
  commentaires text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer REFERENCES public.users(id),
  updated_by integer REFERENCES public.users(id)
);

CREATE TABLE public.commande_ligne (
  id bigserial PRIMARY KEY,
  commande_id bigint NOT NULL REFERENCES public.commande_client(id) ON DELETE CASCADE,
  ordre integer NOT NULL DEFAULT 1,
  designation text NOT NULL DEFAULT '',
  code_piece text,
  quantite numeric(18,6) NOT NULL DEFAULT 1,
  unite text,
  delai_client date,
  prix_unitaire_ht numeric(18,4) NOT NULL DEFAULT 0,
  remise_ligne numeric(8,4) NOT NULL DEFAULT 0,
  taux_tva numeric(8,4) NOT NULL DEFAULT 20,
  total_ht numeric(18,2) NOT NULL DEFAULT 0,
  total_ttc numeric(18,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.commande_historique (
  id bigserial PRIMARY KEY,
  commande_id bigint NOT NULL REFERENCES public.commande_client(id) ON DELETE CASCADE,
  user_id integer REFERENCES public.users(id),
  action text NOT NULL DEFAULT '',
  details jsonb,
  date_action timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.commande_documents (
  id bigserial PRIMARY KEY,
  commande_id bigint NOT NULL REFERENCES public.commande_client(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents_clients(id) ON DELETE RESTRICT,
  type text
);

CREATE TABLE public.affaire (
  id bigserial PRIMARY KEY,
  numero text UNIQUE,
  reference text,
  nom text NOT NULL DEFAULT '',
  client_id varchar(3) REFERENCES public.clients(client_id),
  type_affaire text NOT NULL DEFAULT 'fabrication',
  commande_id bigint REFERENCES public.commande_client(id),
  statut text NOT NULL DEFAULT 'DRAFT',
  date_creation date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.commande_to_affaire (
  id bigserial PRIMARY KEY,
  commande_id bigint NOT NULL REFERENCES public.commande_client(id) ON DELETE CASCADE,
  affaire_id bigint NOT NULL REFERENCES public.affaire(id) ON DELETE CASCADE,
  date_conversion timestamptz NOT NULL DEFAULT now(),
  UNIQUE (commande_id, affaire_id)
);

CREATE TABLE public.centres_frais (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE,
  name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.pieces_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE,
  name text NOT NULL DEFAULT '',
  designation text,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.currencies (
  code text PRIMARY KEY,
  name text NOT NULL,
  symbol text
);

CREATE TABLE public.units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text NOT NULL
);

CREATE TABLE public.warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid REFERENCES public.warehouses(id),
  code text NOT NULL,
  name text,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (warehouse_id, code)
);

CREATE TABLE public.outillages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  designation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.gestion_outils_famille (
  id_famille serial PRIMARY KEY,
  nom_famille text NOT NULL,
  ordre integer,
  image_path text
);

CREATE TABLE public.gestion_outils_geometrie (
  id_geometrie serial PRIMARY KEY,
  id_famille integer REFERENCES public.gestion_outils_famille(id_famille),
  nom_geometrie text NOT NULL,
  ordre integer,
  image_path text
);

CREATE TABLE public.gestion_outils_fournisseur (
  id_fournisseur serial PRIMARY KEY,
  nom text NOT NULL,
  email text,
  telephone text
);

CREATE TABLE public.gestion_outils_outil (
  id_outil serial PRIMARY KEY,
  designation text NOT NULL DEFAULT '',
  id_famille integer REFERENCES public.gestion_outils_famille(id_famille),
  id_geometrie integer REFERENCES public.gestion_outils_geometrie(id_geometrie),
  esquisse text,
  plan text,
  image text
);

CREATE TABLE public.gestion_outils_historique_prix (
  id serial PRIMARY KEY,
  id_outil integer NOT NULL REFERENCES public.gestion_outils_outil(id_outil),
  id_fournisseur integer REFERENCES public.gestion_outils_fournisseur(id_fournisseur),
  prix numeric(12,2) NOT NULL DEFAULT 0,
  date_prix timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.gestion_outils_mouvement_stock (
  id_mouvement serial PRIMARY KEY,
  id_outil integer NOT NULL REFERENCES public.gestion_outils_outil(id_outil),
  quantite numeric(18,3) NOT NULL DEFAULT 0,
  type_mouvement text,
  utilisateur text,
  date_mouvement timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.erp_audit_logs (
  id bigserial PRIMARY KEY,
  user_id integer REFERENCES public.users(id),
  event_type text,
  action text NOT NULL,
  page_key text,
  entity_type text NOT NULL,
  entity_id text,
  path text,
  client_session_id text,
  ip text,
  user_agent text,
  device_type text,
  os text,
  browser text,
  old_values jsonb,
  new_values jsonb,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.factureur (
  biller_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  biller_name text NOT NULL,
  street text,
  house_number text,
  postal_code text,
  city text,
  country text,
  phone text,
  email text,
  default_bank_name text,
  default_iban text,
  default_bic text,
  text_on_invoice text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.facture (
  id bigserial PRIMARY KEY,
  numero varchar(30) NOT NULL UNIQUE,
  client_id varchar(3) NOT NULL REFERENCES public.clients(client_id),
  devis_id bigint REFERENCES public.devis(id),
  commande_id bigint REFERENCES public.commande_client(id),
  affaire_id bigint REFERENCES public.affaire(id),
  date_emission date NOT NULL DEFAULT CURRENT_DATE,
  date_echeance date,
  statut text NOT NULL DEFAULT 'BROUILLON',
  remise_globale numeric(8,4) NOT NULL DEFAULT 0,
  total_ht numeric(18,2) NOT NULL DEFAULT 0,
  total_ttc numeric(18,2) NOT NULL DEFAULT 0,
  commentaires text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.facture_ligne (
  id bigserial PRIMARY KEY,
  facture_id bigint NOT NULL REFERENCES public.facture(id) ON DELETE CASCADE,
  ordre integer NOT NULL,
  designation text NOT NULL,
  code_piece text,
  quantite numeric(18,6) NOT NULL,
  unite text,
  prix_unitaire_ht numeric(18,4) NOT NULL,
  remise_ligne numeric(8,4) NOT NULL DEFAULT 0,
  taux_tva numeric(8,4) NOT NULL DEFAULT 20,
  total_ht numeric(18,2) NOT NULL,
  total_ttc numeric(18,2) NOT NULL
);

CREATE TABLE public.avoir (
  id bigserial PRIMARY KEY,
  numero varchar(30) NOT NULL UNIQUE,
  client_id varchar(3) NOT NULL REFERENCES public.clients(client_id),
  facture_id bigint REFERENCES public.facture(id),
  date_emission date NOT NULL DEFAULT CURRENT_DATE,
  statut text NOT NULL DEFAULT 'BROUILLON',
  motif text,
  total_ht numeric(18,2) NOT NULL DEFAULT 0,
  total_ttc numeric(18,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.avoir_ligne (
  id bigserial PRIMARY KEY,
  avoir_id bigint NOT NULL REFERENCES public.avoir(id) ON DELETE CASCADE,
  ordre integer NOT NULL,
  designation text NOT NULL,
  code_piece text,
  quantite numeric(18,6) NOT NULL,
  unite text,
  prix_unitaire_ht numeric(18,4) NOT NULL,
  remise_ligne numeric(8,4) NOT NULL DEFAULT 0,
  taux_tva numeric(8,4) NOT NULL DEFAULT 20,
  total_ht numeric(18,2) NOT NULL,
  total_ttc numeric(18,2) NOT NULL
);

CREATE TABLE public.paiement (
  id bigserial PRIMARY KEY,
  facture_id bigint NOT NULL REFERENCES public.facture(id),
  client_id varchar(3) NOT NULL REFERENCES public.clients(client_id),
  date_paiement date NOT NULL DEFAULT CURRENT_DATE,
  montant numeric(18,2) NOT NULL,
  mode text,
  reference text,
  commentaire text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.facture_documents (
  id bigserial PRIMARY KEY,
  facture_id bigint NOT NULL REFERENCES public.facture(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents_clients(id) ON DELETE RESTRICT,
  type text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
