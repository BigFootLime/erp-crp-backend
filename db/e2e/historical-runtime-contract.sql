-- SOL-05 only: columns and small legacy tables that exist on the historical
-- production baseline but are not created by the additive patch ledger.
-- This contract is applied only after the full ledger, on disposable cerp_test.

BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'cerp_test'
     OR current_setting('cerp.e2e_isolated', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'SOL-05 historical contract refused outside isolated cerp_test';
  END IF;
END
$guard$;

-- The account administration repositories still consume these columns from
-- the historical users table. They predate the additive patch ledger, so the
-- reduced bootstrap must restore them explicitly for the disposable runtime.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS profile_picture text,
  ADD COLUMN IF NOT EXISTS last_login timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS public.adresse_facturation (
  bill_address_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  street text,
  house_number text,
  address_complement text,
  postal_code text,
  city text,
  country text
);

CREATE TABLE IF NOT EXISTS public.informations_bancaires (
  bank_info_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  bank_name text,
  iban text,
  bic text
);

-- `client.repository.upsertBank` relies on this historical uniqueness contract.
-- A regular unique index still permits multiple NULL values while making
-- `ON CONFLICT (iban)` inferable by PostgreSQL.
CREATE UNIQUE INDEX IF NOT EXISTS informations_bancaires_iban_uidx
  ON public.informations_bancaires (iban);

CREATE TABLE IF NOT EXISTS public.mode_reglement (
  payment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_code text NOT NULL UNIQUE,
  type text
);

ALTER TABLE public.mode_reglement
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS creation_date timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_by text,
  ADD COLUMN IF NOT EXISTS modification_date timestamptz,
  ADD COLUMN IF NOT EXISTS modified_by text;

CREATE TABLE IF NOT EXISTS public.client_payment_modes (
  client_id varchar(3) NOT NULL REFERENCES public.clients(client_id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES public.mode_reglement(payment_id) ON DELETE RESTRICT,
  PRIMARY KEY (client_id, payment_id)
);

ALTER TABLE public.adresse_livraison
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS street text,
  ADD COLUMN IF NOT EXISTS house_number text,
  ADD COLUMN IF NOT EXISTS address_complement text;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS bill_address_id uuid REFERENCES public.adresse_facturation(bill_address_id),
  ADD COLUMN IF NOT EXISTS bank_info_id uuid REFERENCES public.informations_bancaires(bank_info_id),
  ADD COLUMN IF NOT EXISTS website_url text,
  ADD COLUMN IF NOT EXISTS vat_number text,
  ADD COLUMN IF NOT EXISTS naf_code text,
  ADD COLUMN IF NOT EXISTS blocked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS observations text,
  ADD COLUMN IF NOT EXISTS provided_documents_id uuid,
  ADD COLUMN IF NOT EXISTS quality_level text,
  ADD COLUMN IF NOT EXISTS quality_levels text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS logo_path text,
  ADD COLUMN IF NOT EXISTS biller_id uuid REFERENCES public.factureur(biller_id);

-- The quote repository consumes these header fields on every create/read.
-- They belong to the historical production schema and therefore are not
-- introduced by the additive patch ledger replayed on a fresh E2E database.
ALTER TABLE public.devis
  ADD COLUMN IF NOT EXISTS adresse_facturation_id uuid REFERENCES public.adresse_facturation(bill_address_id),
  ADD COLUMN IF NOT EXISTS adresse_livraison_id uuid REFERENCES public.adresse_livraison(delivery_address_id),
  ADD COLUMN IF NOT EXISTS mode_reglement_id uuid REFERENCES public.mode_reglement(payment_id),
  ADD COLUMN IF NOT EXISTS compte_vente_id uuid,
  ADD COLUMN IF NOT EXISTS conditions_paiement_id integer,
  ADD COLUMN IF NOT EXISTS biller_id uuid REFERENCES public.factureur(biller_id);

-- Same historical boundary for quote lines: the current repository writes a
-- normalized description and optional UUID links, whereas the reduced legacy
-- bootstrap only carries the older `designation`/`code_piece` fields.
ALTER TABLE public.devis_ligne
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS article_id uuid,
  ADD COLUMN IF NOT EXISTS piece_technique_id uuid;

UPDATE public.devis_ligne
SET description = COALESCE(description, designation, '')
WHERE description IS NULL;

ALTER TABLE public.devis_ligne
  ALTER COLUMN description SET NOT NULL;

-- The current command repository consumes these historical header fields.
-- They predate the additive patch ledger, so a fresh database otherwise has
-- only the reduced bootstrap header and cannot create a customer order.
ALTER TABLE public.commande_client
  ADD COLUMN IF NOT EXISTS destinataire_id uuid REFERENCES public.adresse_livraison(delivery_address_id),
  ADD COLUMN IF NOT EXISTS emetteur text,
  ADD COLUMN IF NOT EXISTS code_client text,
  ADD COLUMN IF NOT EXISTS arc_edi boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS arc_date_envoi timestamptz,
  ADD COLUMN IF NOT EXISTS compteur_affaire_id uuid,
  ADD COLUMN IF NOT EXISTS mode_port_id uuid,
  ADD COLUMN IF NOT EXISTS mode_reglement_id uuid REFERENCES public.mode_reglement(payment_id),
  ADD COLUMN IF NOT EXISTS conditions_paiement_id integer,
  ADD COLUMN IF NOT EXISTS biller_id uuid REFERENCES public.factureur(biller_id),
  ADD COLUMN IF NOT EXISTS compte_vente_id uuid,
  ADD COLUMN IF NOT EXISTS commentaire text,
  ADD COLUMN IF NOT EXISTS remise_globale numeric(8,4) NOT NULL DEFAULT 0;

ALTER TABLE public.commande_ligne
  ADD COLUMN IF NOT EXISTS delai_interne date,
  ADD COLUMN IF NOT EXISTS devis_numero text,
  ADD COLUMN IF NOT EXISTS famille text;

CREATE TABLE IF NOT EXISTS public.commande_echeance (
  id bigserial PRIMARY KEY,
  commande_id bigint NOT NULL REFERENCES public.commande_client(id) ON DELETE CASCADE,
  libelle text NOT NULL,
  date_echeance date NOT NULL,
  pourcentage numeric(8,4),
  montant numeric(18,2)
);

ALTER TABLE public.commande_to_affaire
  ADD COLUMN IF NOT EXISTS commentaire text;

ALTER TABLE public.affaire
  ADD COLUMN IF NOT EXISTS devis_id bigint REFERENCES public.devis(id),
  ADD COLUMN IF NOT EXISTS date_ouverture date,
  ADD COLUMN IF NOT EXISTS date_cloture date,
  ADD COLUMN IF NOT EXISTS commentaire text;

ALTER TABLE public.centres_frais
  ADD COLUMN IF NOT EXISTS designation text,
  ADD COLUMN IF NOT EXISTS type_cf text,
  ADD COLUMN IF NOT EXISTS section text;

UPDATE public.centres_frais
SET designation = COALESCE(designation, name)
WHERE designation IS NULL;

ALTER TABLE public.pieces_families
  ADD COLUMN IF NOT EXISTS type_famille text,
  ADD COLUMN IF NOT EXISTS section text;

ALTER TABLE public.commande_historique
  ADD COLUMN IF NOT EXISTS ancien_statut text,
  ADD COLUMN IF NOT EXISTS nouveau_statut text,
  ADD COLUMN IF NOT EXISTS commentaire text;

ALTER TABLE public.stock_levels
  ADD COLUMN IF NOT EXISTS min_qty numeric(18,3),
  ADD COLUMN IF NOT EXISTS reorder_qty numeric(18,3);

ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS doc_type text,
  ADD COLUMN IF NOT EXISTS doc_id text;

-- The UUID normalizer converts the historical BIGSERIAL key but PostgreSQL
-- cannot carry a sequence default across the type change. Runtime inserts do
-- not provide this immutable event id, so restore the UUID-native default.
ALTER TABLE public.stock_movement_event_log
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

CREATE TABLE IF NOT EXISTS public.gestion_outils_fabricant (
  id_fabricant serial PRIMARY KEY,
  name text NOT NULL,
  logo text
);

-- Legacy outillage association tables are consumed by the supplier 360
-- repository but predate the additive patch ledger.
CREATE TABLE IF NOT EXISTS public.gestion_outils_outil_fournisseur (
  id_outil integer NOT NULL REFERENCES public.gestion_outils_outil(id_outil) ON DELETE CASCADE,
  id_fournisseur integer NOT NULL REFERENCES public.gestion_outils_fournisseur(id_fournisseur) ON DELETE CASCADE,
  PRIMARY KEY (id_outil, id_fournisseur)
);

CREATE TABLE IF NOT EXISTS public.gestion_outils_fournisseur_fabricant (
  id_fabricant integer NOT NULL REFERENCES public.gestion_outils_fabricant(id_fabricant) ON DELETE CASCADE,
  id_fournisseur integer NOT NULL REFERENCES public.gestion_outils_fournisseur(id_fournisseur) ON DELETE CASCADE,
  PRIMARY KEY (id_fabricant, id_fournisseur)
);

-- These legacy catalogue tables predate the additive patch ledger too. The
-- runtime detail and pricing endpoints nevertheless depend on their deployed
-- names, so the disposable baseline must reproduce that historical contract.
CREATE TABLE IF NOT EXISTS public.gestion_outils_revetement (
  id_revetement serial PRIMARY KEY,
  nom text NOT NULL,
  id_fabricant integer NULL REFERENCES public.gestion_outils_fabricant(id_fabricant) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public.gestion_outils_outil_revetement (
  id_outil integer NOT NULL REFERENCES public.gestion_outils_outil(id_outil) ON DELETE CASCADE,
  id_revetement integer NOT NULL REFERENCES public.gestion_outils_revetement(id_revetement) ON DELETE CASCADE,
  PRIMARY KEY (id_outil, id_revetement)
);

CREATE TABLE IF NOT EXISTS public.gestion_outils_arete_coupe (
  id_arete_coupe serial PRIMARY KEY,
  nom_arete_coupe text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.gestion_outils_geometrie_aretecoupe (
  id_geometrie integer NOT NULL REFERENCES public.gestion_outils_geometrie(id_geometrie) ON DELETE CASCADE,
  id_arete_coupe integer NOT NULL REFERENCES public.gestion_outils_arete_coupe(id_arete_coupe) ON DELETE CASCADE,
  PRIMARY KEY (id_geometrie, id_arete_coupe)
);

CREATE TABLE IF NOT EXISTS public.gestion_outils_valeur_arete_coupe (
  id_valeur_arete serial PRIMARY KEY,
  id_outil integer NOT NULL REFERENCES public.gestion_outils_outil(id_outil) ON DELETE CASCADE,
  id_arete_coupe integer NULL REFERENCES public.gestion_outils_arete_coupe(id_arete_coupe) ON DELETE SET NULL,
  valeur numeric(18,6) NULL
);

-- The historical bootstrap intentionally starts from the oldest known name
-- (`id`). Production repositories have long consumed `id_historique`.
DO $outillage_history_key$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'gestion_outils_historique_prix'
      AND column_name = 'id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'gestion_outils_historique_prix'
      AND column_name = 'id_historique'
  ) THEN
    ALTER TABLE public.gestion_outils_historique_prix RENAME COLUMN id TO id_historique;
  END IF;
END
$outillage_history_key$;

CREATE TABLE IF NOT EXISTS public.gestion_outils_stock (
  id_outil integer PRIMARY KEY REFERENCES public.gestion_outils_outil(id_outil) ON DELETE CASCADE,
  quantite numeric(18,3) NOT NULL DEFAULT 0,
  quantite_minimale numeric(18,3) NOT NULL DEFAULT 0,
  date_maj timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.gestion_outils_outil
  ADD COLUMN IF NOT EXISTS id_fabricant integer REFERENCES public.gestion_outils_fabricant(id_fabricant),
  ADD COLUMN IF NOT EXISTS reference_fabricant text,
  ADD COLUMN IF NOT EXISTS designation_outil_cnc text;

DO $verify$
DECLARE
  event_default text;
BEGIN
  SELECT column_default INTO event_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'stock_movement_event_log'
    AND column_name = 'id';

  IF event_default IS NULL OR event_default NOT ILIKE '%gen_random_uuid%' THEN
    RAISE EXCEPTION 'SOL-05 historical contract verification failed: event id default missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'commande_historique' AND column_name = 'nouveau_statut'
  ) THEN
    RAISE EXCEPTION 'SOL-05 historical contract verification failed: commande status spine missing';
  END IF;

  IF (
    SELECT count(*)
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name IN ('profile_picture', 'last_login', 'created_at')
  ) <> 3 THEN
    RAISE EXCEPTION 'SOL-05 historical contract verification failed: account administration columns missing';
  END IF;

  IF (
    SELECT count(*)
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pieces_families'
      AND column_name IN ('type_famille', 'section')
  ) <> 2 OR (
    SELECT count(*)
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'centres_frais'
      AND column_name IN ('designation', 'type_cf', 'section')
  ) <> 3 THEN
    RAISE EXCEPTION 'SOL-05 historical contract verification failed: technical referential columns missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'commande_client' AND column_name = 'destinataire_id'
  ) THEN
    RAISE EXCEPTION 'SOL-05 historical contract verification failed: customer order header missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'devis' AND column_name = 'adresse_facturation_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'devis' AND column_name = 'biller_id'
  ) THEN
    RAISE EXCEPTION 'SOL-05 historical contract verification failed: quote header missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'devis_ligne' AND column_name = 'description'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'devis_ligne' AND column_name = 'piece_technique_id'
  ) THEN
    RAISE EXCEPTION 'SOL-05 historical contract verification failed: quote line contract missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'commande_ligne' AND column_name = 'delai_interne'
  ) THEN
    RAISE EXCEPTION 'SOL-05 historical contract verification failed: customer order line missing';
  END IF;

  IF to_regclass('public.commande_echeance') IS NULL THEN
    RAISE EXCEPTION 'SOL-05 historical contract verification failed: customer order schedule missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'clients'
      AND column_name = 'client_id'
      AND column_default ILIKE '%clients_client_id_seq%'
  ) THEN
    RAISE EXCEPTION 'SOL-05 historical contract verification failed: client id allocator missing';
  END IF;

  IF to_regclass('public.gestion_outils_outil_fournisseur') IS NULL
     OR to_regclass('public.gestion_outils_fournisseur_fabricant') IS NULL
     OR to_regclass('public.gestion_outils_outil_revetement') IS NULL
     OR to_regclass('public.gestion_outils_valeur_arete_coupe') IS NULL THEN
    RAISE EXCEPTION 'SOL-05 historical contract verification failed: outillage catalogue links missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'gestion_outils_mouvement_stock'
      AND column_name = 'id_mouvement'
  ) THEN
    RAISE EXCEPTION 'SOL-05 historical contract verification failed: outillage movement key missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'gestion_outils_historique_prix'
      AND column_name = 'id_historique'
  ) THEN
    RAISE EXCEPTION 'SOL-05 historical contract verification failed: outillage price-history key missing';
  END IF;
END
$verify$;

COMMIT;
