-- Immutable seller tariff authority for accepted intercompany purchases.
CREATE TABLE IF NOT EXISTS public.intercompany_supplier_offer_revisions (
  relation_id uuid NOT NULL REFERENCES public.intercompany_supplier_relations(id) ON DELETE RESTRICT,
  supplier_catalogue_mapping_id uuid NOT NULL,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  snapshot_sha256 text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (relation_id,supplier_catalogue_mapping_id,version),
  CONSTRAINT intercompany_supplier_offer_revision_version_ck CHECK(version>0),
  CONSTRAINT intercompany_supplier_offer_revision_hash_ck CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$')
);
