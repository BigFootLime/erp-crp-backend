BEGIN;
SET LOCAL lock_timeout='10s';
-- Missing draft prices are explicitly unknown until the buyer confirms them.
ALTER TABLE public.commande_fournisseur_ligne ALTER COLUMN prix_unitaire_ht DROP NOT NULL;
CREATE TABLE IF NOT EXISTS public.consumable_commands (
  idempotency_key uuid PRIMARY KEY,
  actor_id integer NOT NULL REFERENCES public.users(id),
  command_type text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  of_id bigint REFERENCES public.ordres_fabrication(id),
  article_id uuid REFERENCES public.articles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.consumable_commands OWNER TO cerp_app;
ALTER TABLE public.of_material_revision_resolutions ALTER COLUMN command_key DROP NOT NULL;
ALTER TABLE public.of_material_revision_resolutions ADD COLUMN consumable_command_key uuid
  REFERENCES public.consumable_commands(idempotency_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.of_material_revision_resolutions ADD CONSTRAINT revision_resolution_one_command
  CHECK(num_nonnulls(command_key,consumable_command_key)=1);
-- Finite evidence of an explicitly dispensed receipt, never a stock balance
-- or a fabricated quality inspection. Physical quantities remain in stock_*.
CREATE TABLE public.consumable_receipt_admissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_line_id uuid NOT NULL UNIQUE REFERENCES public.reception_fournisseur_lignes(id),
  lot_id uuid NOT NULL UNIQUE REFERENCES public.lots(id),
  quantity numeric(14,3) NOT NULL CHECK(quantity>0),
  unit text NOT NULL,
  created_by integer NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.consumable_receipt_admissions OWNER TO cerp_app;
CREATE TRIGGER consumable_receipt_admissions_immutable BEFORE UPDATE OR DELETE ON public.consumable_receipt_admissions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
COMMIT;
