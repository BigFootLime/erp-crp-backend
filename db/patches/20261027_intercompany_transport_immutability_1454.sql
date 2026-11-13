BEGIN;

CREATE OR REPLACE FUNCTION public.cerp_intercompany_outbox_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.source_company_id,NEW.destination_company_id,NEW.environment,NEW.kind,NEW.aggregate_id,NEW.revision,NEW.payload_sha256,NEW.message,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.source_company_id,OLD.destination_company_id,OLD.environment,OLD.kind,OLD.aggregate_id,OLD.revision,OLD.payload_sha256,OLD.message,OLD.created_at) THEN
    RAISE EXCEPTION 'Intercompany message content is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cerp_intercompany_outbox_immutable ON public.cerp_intercompany_outbox;
CREATE TRIGGER cerp_intercompany_outbox_immutable BEFORE UPDATE ON public.cerp_intercompany_outbox
FOR EACH ROW EXECUTE FUNCTION public.cerp_intercompany_outbox_immutable();

CREATE OR REPLACE FUNCTION public.cerp_intercompany_inbox_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.source_company_id,NEW.destination_company_id,NEW.environment,NEW.kind,NEW.aggregate_id,NEW.revision,NEW.payload_sha256,NEW.payload,NEW.received_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.source_company_id,OLD.destination_company_id,OLD.environment,OLD.kind,OLD.aggregate_id,OLD.revision,OLD.payload_sha256,OLD.payload,OLD.received_at) THEN
    RAISE EXCEPTION 'Intercompany receipt content is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cerp_intercompany_inbox_immutable ON public.cerp_intercompany_inbox;
CREATE TRIGGER cerp_intercompany_inbox_immutable BEFORE UPDATE ON public.cerp_intercompany_inbox
FOR EACH ROW EXECUTE FUNCTION public.cerp_intercompany_inbox_immutable();

CREATE OR REPLACE FUNCTION public.cerp_intercompany_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Intercompany business evidence is append-only' USING ERRCODE='23514';
END $$;
DROP TRIGGER IF EXISTS cerp_intercompany_decisions_append_only ON public.cerp_intercompany_decision_receipts;
CREATE TRIGGER cerp_intercompany_decisions_append_only BEFORE UPDATE OR DELETE ON public.cerp_intercompany_decision_receipts
FOR EACH ROW EXECUTE FUNCTION public.cerp_intercompany_append_only();
DROP TRIGGER IF EXISTS cerp_intercompany_lines_append_only ON public.cerp_intercompany_order_line_links;
CREATE TRIGGER cerp_intercompany_lines_append_only BEFORE UPDATE OR DELETE ON public.cerp_intercompany_order_line_links
FOR EACH ROW EXECUTE FUNCTION public.cerp_intercompany_append_only();

CREATE OR REPLACE FUNCTION public.cerp_intercompany_request_source_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.id,NEW.buyer_company_id,NEW.supplier_company_id,NEW.environment,NEW.buyer_purchase_order_id,NEW.buyer_sales_order_id,NEW.relation_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.buyer_company_id,OLD.supplier_company_id,OLD.environment,OLD.buyer_purchase_order_id,OLD.buyer_sales_order_id,OLD.relation_id,OLD.created_at) THEN
    RAISE EXCEPTION 'Intercompany request participants and source are immutable' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.payload_sha256,NEW.payload,NEW.buyer_legal_snapshot,NEW.final_delivery_address_snapshot,NEW.revision)
    IS DISTINCT FROM ROW(OLD.payload_sha256,OLD.payload,OLD.buyer_legal_snapshot,OLD.final_delivery_address_snapshot,OLD.revision)
    AND NOT (OLD.state='PENDING_SUPPLIER_APPROVAL' AND NEW.state='PENDING_SUPPLIER_APPROVAL' AND NEW.revision>OLD.revision) THEN
    RAISE EXCEPTION 'A decided intercompany request snapshot is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.supplier_sales_order_id IS NOT NULL AND NEW.supplier_sales_order_id IS DISTINCT FROM OLD.supplier_sales_order_id THEN
    RAISE EXCEPTION 'Intercompany native customer order binding is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cerp_intercompany_request_source_immutable ON public.cerp_intercompany_requests;
CREATE TRIGGER cerp_intercompany_request_source_immutable BEFORE UPDATE ON public.cerp_intercompany_requests
FOR EACH ROW EXECUTE FUNCTION public.cerp_intercompany_request_source_immutable();

COMMIT;
