import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";
import { centralCanonicalJson } from "../../planning/domain/central-canonical-json";
import { assertPromiseParts, measureDeliveryPromises, type DeliveryMeasure } from "../domain/delivery-promises";
import type { AuditContext } from "../types/affaire.types";
import type { ReviseDeliveryPromisesInput } from "../validators/delivery-promises.validators";
type Root = {
    id: string;
    allocation_id: string;
    commande_id: number;
    line_id: number;
    affaire_id: number;
    initial_quantity: number;
    initial_due_date: string;
    version: number;
    client_id: string;
    designation: string;
    commande_numero: string;
    ar_id: string;
    shipped_quantity: number;
};
type Part = {
    id: string;
    root_id: string;
    quantity: number;
    due_date: string;
    retired_at: string | null;
    shipped_quantity: number;
};
type Shipment = {
    root_id: string;
    part_id: string;
    quantity: number;
    due_date: string;
    delivered_date: string | null;
};
const rootsSql = `SELECT r.id::text,r.allocation_id::text,r.commande_id::int,r.line_id::int,r.affaire_id::int,
  r.initial_quantity::float8,r.initial_due_date::text,r.version::int,r.ar_id::text,
  cc.client_id,cc.numero AS commande_numero,cl.designation,
  COALESCE((SELECT sum(s.quantity) FROM public.delivery_promise_shipments s JOIN public.delivery_promise_parts p ON p.id=s.part_id WHERE p.root_id=r.id),0)::float8 AS shipped_quantity
  FROM public.delivery_promise_roots r JOIN public.commande_client cc ON cc.id=r.commande_id JOIN public.commande_ligne cl ON cl.id=r.line_id`;
export async function readDeliveryPromises(affaireId: number) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        if (!(await client.query("SELECT id FROM public.affaire WHERE id=$1", [affaireId])).rowCount)
            throw new HttpError(404, "AFFAIRE_NOT_FOUND", "Affaire introuvable.");
        const roots = (await client.query<Root>(rootsSql + " WHERE r.affaire_id=$1 ORDER BY r.line_id,r.id", [affaireId])).rows;
        const ids = roots.map(r => r.id);
        const parts = (await client.query<Part>(`SELECT p.id::text,p.root_id::text,p.quantity::float8,p.due_date::text,p.retired_at::text,
      COALESCE(sum(s.quantity),0)::float8 AS shipped_quantity FROM public.delivery_promise_parts p
      LEFT JOIN public.delivery_promise_shipments s ON s.part_id=p.id WHERE p.root_id=ANY($1::uuid[])
      GROUP BY p.id ORDER BY p.created_at,p.due_date,p.id`, [ids])).rows;
        const shipments = (await client.query<Shipment>(`SELECT p.root_id::text,s.part_id::text,s.quantity::float8,s.due_date_at_shipment::text AS due_date,
      CASE WHEN bl.statut='DELIVERED' THEN (SELECT (min(proof.delivered_at) AT TIME ZONE 'Europe/Paris')::date::text
        FROM public.bon_livraison_delivery_proofs proof WHERE proof.bon_livraison_id=bl.id) END AS delivered_date
      FROM public.delivery_promise_shipments s JOIN public.delivery_promise_parts p ON p.id=s.part_id
      JOIN public.bon_livraison_ligne_allocations a ON a.id=s.bl_allocation_id
      JOIN public.bon_livraison_ligne l ON l.id=a.bon_livraison_ligne_id JOIN public.bon_livraison bl ON bl.id=l.bon_livraison_id
      WHERE p.root_id=ANY($1::uuid[]) ORDER BY s.created_at,s.id`, [ids])).rows;
        const today = (await client.query<{
            today: string;
        }>(`SELECT (now() AT TIME ZONE COALESCE((SELECT c.timezone
      FROM public.planning_central_settings settings JOIN public.programmation_calendars c ON c.id=settings.workshop_calendar_id WHERE settings.singleton),'Europe/Paris'))::date::text AS today`)).rows[0].today;
        const initial: DeliveryMeasure[] = [], revised: DeliveryMeasure[] = [];
        const anomalies: string[] = [];
        for (const root of roots) {
            let remaining = root.initial_quantity;
            for (const shipment of shipments.filter(s => s.root_id === root.id)) {
                const quantity = Math.min(remaining, shipment.quantity);
                if (quantity > 0) {
                    initial.push({ ...shipment, quantity, due_date: root.initial_due_date });
                    revised.push({ ...shipment, quantity });
                }
                remaining -= quantity;
            }
            if (remaining > 0)
                initial.push({ quantity: remaining, due_date: root.initial_due_date, delivered_date: null });
            const active = parts.filter(p => p.root_id === root.id && !p.retired_at);
            for (const part of active) {
                const quantity = Math.min(remaining, Math.max(0, part.quantity - part.shipped_quantity));
                if (quantity > 0)
                    revised.push({ quantity, due_date: part.due_date, delivered_date: null });
                remaining -= quantity;
            }
            if (remaining > 0) {
                revised.push({ quantity: remaining, due_date: root.initial_due_date, delivered_date: null });
                anomalies.push(`Répartition incomplète pour ${root.commande_numero}, ligne ${root.line_id}.`);
            }
            if (root.shipped_quantity > root.initial_quantity + 0.000001)
                anomalies.push(`Expéditions supérieures à l'AR pour ${root.commande_numero}, ligne ${root.line_id}.`);
        }
        const history = (await client.query(`SELECT e.id::text,e.root_id::text,e.reason,e.before_parts,e.after_parts,e.created_at::text,
      e.actor_id,u.username AS actor_name FROM public.delivery_promise_events e LEFT JOIN public.users u ON u.id=e.actor_id
      WHERE e.root_id=ANY($1::uuid[]) ORDER BY e.created_at DESC,e.id DESC LIMIT 100`, [ids])).rows;
        const untracked = (await client.query<{
            quantity: number;
        }>(`SELECT COALESCE(sum(a.qty_ordered),0)::float8 AS quantity
      FROM public.commande_ligne_affaire_allocation a WHERE a.livraison_affaire_id=$1
      AND NOT EXISTS(SELECT 1 FROM public.delivery_promise_roots r WHERE r.allocation_id=a.id)`, [affaireId])).rows[0].quantity;
        const delays = (await client.query(`SELECT r.id::text AS root_id,public.workshop_delay_days(r.initial_due_date,$2::date) AS working_days
      FROM public.delivery_promise_roots r WHERE r.id=ANY($1::uuid[])`, [ids, today])).rows;
        await client.query("COMMIT");
        return { roots, parts, history, delays, today, anomalies, untracked_quantity: untracked,
            metric_basis: "DELIVERED_WITH_PROOF", initial: measureDeliveryPromises(initial, today), revised: measureDeliveryPromises(revised, today) };
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        client.release();
    }
}
export async function reviseDeliveryPromises(affaireId: number, input: ReviseDeliveryPromisesInput, audit: AuditContext) {
    const client = await pool.connect();
    return withRealtimeOutboxTransaction(client, async (tx) => {
        // Same lock order as stock/planning writers; the promise never changes their quantities.
        await tx.query("SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE");
        const replay = (await tx.query<{
            root_id: string;
            request: unknown;
            after_parts: unknown;
        }>("SELECT root_id::text,request,after_parts FROM public.delivery_promise_events WHERE actor_id=$1 AND request_key=$2", [audit.user_id, input.request_key])).rows[0];
        if (replay) {
            if (centralCanonicalJson(replay.request) !== centralCanonicalJson({ affaireId, ...input }))
                throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette clé a déjà servi à une autre modification.");
            return { root_id: replay.root_id, replayed: true };
        }
        const root = (await tx.query<Root>(rootsSql + " WHERE r.id=$1::uuid AND r.affaire_id=$2 FOR UPDATE OF r", [input.root_id, affaireId])).rows[0];
        if (!root)
            throw new HttpError(404, "PROMISE_NOT_FOUND", "Engagement introuvable dans cette affaire.");
        if (root.version !== input.expected_version)
            throw new HttpError(409, "PROMISE_STALE", "La répartition a changé. Rechargez l'affaire.");
        const currentAllocation = (await tx.query<{
            quantity: number;
        }>("SELECT qty_ordered::float8 AS quantity FROM public.commande_ligne_affaire_allocation WHERE id=$1 FOR SHARE", [root.allocation_id])).rows[0];
        if (!currentAllocation || Math.abs(currentAllocation.quantity - root.initial_quantity) > 0.000001)
            throw new HttpError(409, "PROMISE_ORDER_QUANTITY_CHANGED", "La quantité commerciale a été modifiée depuis l'AR. Réconciliez l'avenant de commande avant de répartir les dates.");
        assertPromiseParts(input.parts, root.initial_quantity - root.shipped_quantity);
        const before = (await tx.query(`SELECT p.id::text,p.quantity::float8,p.due_date::text,
      COALESCE((SELECT sum(s.quantity) FROM public.delivery_promise_shipments s WHERE s.part_id=p.id),0)::float8 AS shipped_quantity
      FROM public.delivery_promise_parts p WHERE p.root_id=$1::uuid AND p.retired_at IS NULL ORDER BY p.due_date,p.id FOR UPDATE`, [root.id])).rows;
        const event = (await tx.query<{
            id: string;
        }>(`INSERT INTO public.delivery_promise_events(root_id,actor_id,request_key,request,reason,before_parts,after_parts)
      VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7::jsonb) RETURNING id::text`, [root.id, audit.user_id, input.request_key, JSON.stringify({ affaireId, ...input }), input.reason, JSON.stringify(before), JSON.stringify(input.parts)])).rows[0];
        await tx.query("UPDATE public.delivery_promise_parts SET retired_at=now() WHERE root_id=$1 AND retired_at IS NULL", [root.id]);
        for (const part of input.parts)
            await tx.query(`INSERT INTO public.delivery_promise_parts(root_id,quantity,due_date,revision_event_id) VALUES($1,$2,$3,$4)`, [root.id, part.quantity, part.due_date, event.id]);
        await tx.query("UPDATE public.delivery_promise_roots SET version=version+1 WHERE id=$1", [root.id]);
        await tx.query("UPDATE public.planning_central_settings SET revision=revision+1,updated_at=clock_timestamp() WHERE singleton");
        // Only this client's operations are invalidated. Other clients retain their committed capacity.
        await tx.query(`INSERT INTO public.planning_recalculation_jobs(entity_table,entity_id,source_revision)
      SELECT 'planning_tasks',t.id,s.revision FROM public.planning_tasks t
      JOIN public.of_operations op ON op.id=t.operation_id JOIN public.ordres_fabrication o ON o.id=op.of_id
      CROSS JOIN public.planning_central_settings s WHERE s.singleton AND o.client_id=$1 AND o.statut NOT IN('ANNULE','TERMINE','CLOTURE')`, [root.client_id]);
        await repoInsertAuditLog({ tx, user_id: audit.user_id, ip: audit.ip, user_agent: audit.user_agent, device_type: audit.device_type, os: audit.os, browser: audit.browser,
            body: { event_type: "ACTION", action: "affaire.delivery-promise.revise", entity_type: "affaire", entity_id: String(affaireId), page_key: audit.page_key, path: audit.path, client_session_id: audit.client_session_id,
                details: { root_id: root.id, initial_ar_id: root.ar_id, reason: input.reason, before, after: input.parts, client_id: root.client_id } } });
        await enqueueEntityChanged(tx, { entityType: "AFFAIRE", entityId: String(affaireId), action: "updated", module: "affaires", at: new Date().toISOString(), invalidateKeys: [`affaires:detail:${affaireId}`] }, { deduplicationKey: `delivery-promise:${event.id}` });
        return { root_id: root.id, version: root.version + 1, event_id: event.id, replayed: false };
    });
}
/** Called inside the canonical shipment transaction. The due date becomes evidence. */
export async function captureShipmentPromises(tx: PoolClient, deliveryId: string) {
    const allocations = (await tx.query<{
        id: string;
        root_id: string;
        quantity: number;
    }>(`SELECT a.id::text,r.id::text AS root_id,a.quantite::float8 AS quantity
    FROM public.bon_livraison_ligne_allocations a JOIN public.bon_livraison_ligne l ON l.id=a.bon_livraison_ligne_id
    JOIN public.delivery_promise_roots r ON r.allocation_id=a.commande_ligne_affaire_allocation_id
    WHERE l.bon_livraison_id=$1::uuid ORDER BY r.id,a.id FOR UPDATE OF r`, [deliveryId])).rows;
    for (const allocation of allocations) {
        if ((await tx.query("SELECT id FROM public.delivery_promise_shipments WHERE bl_allocation_id=$1 LIMIT 1", [allocation.id])).rowCount)
            continue;
        const parts = (await tx.query<Part>(`SELECT p.id::text,p.root_id::text,p.quantity::float8,p.due_date::text,p.retired_at::text,
      COALESCE((SELECT sum(s.quantity) FROM public.delivery_promise_shipments s WHERE s.part_id=p.id),0)::float8 AS shipped_quantity
      FROM public.delivery_promise_parts p WHERE p.root_id=$1 AND p.retired_at IS NULL ORDER BY p.due_date,p.created_at,p.id FOR UPDATE`, [allocation.root_id])).rows;
        let remaining = allocation.quantity;
        for (const part of parts) {
            const quantity = Math.min(remaining, Math.max(0, part.quantity - part.shipped_quantity));
            if (quantity > 0)
                await tx.query(`INSERT INTO public.delivery_promise_shipments(part_id,bl_allocation_id,quantity,due_date_at_shipment) VALUES($1,$2,$3,$4)`, [part.id, allocation.id, quantity, part.due_date]);
            remaining -= quantity;
        }
        if (remaining > 0.000001)
            throw new HttpError(409, "PROMISE_SHIPMENT_EXCEEDS_ORDER", "L'expédition dépasse la quantité restant sur l'engagement client.");
    }
}
