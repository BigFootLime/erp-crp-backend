import crypto from "node:crypto";

import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { autoplanGreedySequential } from "../../planning/services/autoplan.service";
import type {
  ConfirmQuickCommandeBodyDTO,
  PreviewQuickCommandeBodyDTO,
} from "../validators/quick-commande.validators";
import type {
  QuickCommandeConfirmResponse,
  QuickCommandePlannedOperation,
  QuickCommandePreviewResponse,
  QuickCommandeResource,
} from "../types/quick-commande.types";

type AuditContext = {
  user_id: number;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};

function isPgUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505";
}

function toInt(value: unknown, label = "id"): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

function parseJsonb<T>(value: unknown, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Missing ${label}`);
  }
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }
  return value as T;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isoDateFromTs(ts: string | null): string | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

async function selectDefaultResource(q: Pick<PoolClient, "query">): Promise<QuickCommandeResource> {
  const posteRes = await q.query<{ id: string }>(
    `
      SELECT p.id::text AS id
      FROM public.postes p
      WHERE p.archived_at IS NULL
        AND p.is_active IS TRUE
      ORDER BY p.code ASC, p.id ASC
      LIMIT 1
    `
  );
  const posteId = posteRes.rows[0]?.id ?? null;
  if (posteId) {
    return { resource_type: "POSTE", poste_id: posteId, machine_id: null };
  }

  const machineRes = await q.query<{ id: string }>(
    `
      SELECT m.id::text AS id
      FROM public.machines m
      WHERE m.archived_at IS NULL
        AND m.is_available IS TRUE
      ORDER BY m.code ASC, m.id ASC
      LIMIT 1
    `
  );
  const machineId = machineRes.rows[0]?.id ?? null;
  if (machineId) {
    return { resource_type: "MACHINE", machine_id: machineId, poste_id: null };
  }

  throw new HttpError(409, "NO_RESOURCES", "No planning resources available (postes/machines)");
}

async function listBlockingEvents(q: Pick<PoolClient, "query">, params: {
  resource: QuickCommandeResource;
  from_ts: string;
  to_ts: string;
}): Promise<Array<{ start_ts: string; end_ts: string }>> {
  if (params.resource.resource_type === "POSTE") {
    const res = await q.query<{ start_ts: string; end_ts: string }>(
      `
        SELECT e.start_ts::text AS start_ts, e.end_ts::text AS end_ts
        FROM public.planning_events e
        WHERE e.poste_id = $1::uuid
          AND e.archived_at IS NULL
          AND e.allow_overlap IS NOT TRUE
          AND e.end_ts > $2::timestamptz
          AND e.start_ts < $3::timestamptz
        ORDER BY e.start_ts ASC, e.id ASC
        LIMIT 5000
      `,
      [params.resource.poste_id, params.from_ts, params.to_ts]
    );
    return res.rows;
  }

  const res = await q.query<{ start_ts: string; end_ts: string }>(
    `
      SELECT e.start_ts::text AS start_ts, e.end_ts::text AS end_ts
      FROM public.planning_events e
      WHERE e.machine_id = $1::uuid
        AND e.archived_at IS NULL
        AND e.allow_overlap IS NOT TRUE
        AND e.end_ts > $2::timestamptz
        AND e.start_ts < $3::timestamptz
      ORDER BY e.start_ts ASC, e.id ASC
      LIMIT 5000
    `,
    [params.resource.machine_id, params.from_ts, params.to_ts]
  );
  return res.rows;
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export async function repoPreviewQuickCommande(params: {
  body: PreviewQuickCommandeBodyDTO;
  user_id: number;
}): Promise<QuickCommandePreviewResponse> {
  const b = params.body;

  const pieceRes = await pool.query<{ id: string; code_piece: string; designation: string }>(
    `
      SELECT pt.id::text AS id, pt.code_piece, pt.designation
      FROM public.pieces_techniques pt
      WHERE pt.id = $1::uuid
        AND pt.deleted_at IS NULL
      LIMIT 1
    `,
    [b.piece_technique_id]
  );
  const piece = pieceRes.rows[0] ?? null;
  if (!piece) {
    throw new HttpError(404, "PIECE_TECHNIQUE_NOT_FOUND", "Piece technique not found");
  }

  const opsRes = await pool.query<{ phase: number; designation: string; duration_hours: number }>(
    `
      SELECT
        pto.phase::int AS phase,
        pto.designation,
        ROUND((COALESCE(pto.tp,0) + COALESCE(pto.tf_unit,0) * COALESCE(pto.qte,1)) * COALESCE(pto.coef,1), 3)::float8 AS duration_hours
      FROM public.pieces_techniques_operations pto
      WHERE pto.piece_technique_id = $1::uuid
      ORDER BY pto.phase ASC, pto.id ASC
    `,
    [b.piece_technique_id]
  );

  const tasks = opsRes.rows.map((r) => ({
    phase: r.phase,
    designation: r.designation,
    duration_minutes: Math.max(1, Math.ceil(Number(r.duration_hours) * 60)),
  }));

  const requestedResource: QuickCommandeResource | null = b.poste_id
    ? { resource_type: "POSTE", poste_id: b.poste_id, machine_id: null }
    : b.machine_id
      ? { resource_type: "MACHINE", machine_id: b.machine_id, poste_id: null }
      : null;

  const resource = requestedResource ?? (await selectDefaultResource(pool));
  const startTs = b.start_ts ?? new Date().toISOString();

  const horizonTo = new Date(Date.parse(startTs) + 1000 * 60 * 60 * 24 * 120).toISOString();
  const blocking = await listBlockingEvents(pool, {
    resource,
    from_ts: startTs,
    to_ts: horizonTo,
  });

  const planned = autoplanGreedySequential({
    start_ts: startTs,
    resource:
      resource.resource_type === "POSTE"
        ? { resource_type: "POSTE", poste_id: resource.poste_id }
        : { resource_type: "MACHINE", machine_id: resource.machine_id },
    tasks,
    blocking_events: blocking,
    step_minutes: b.step_minutes,
  });

  const operations: QuickCommandePlannedOperation[] = planned.map((p) => {
    const base = {
      phase: p.phase,
      designation: p.designation,
      duration_minutes: p.duration_minutes,
      start_ts: p.start_ts,
      end_ts: p.end_ts,
    };

    if (p.resource_type === "POSTE") {
      return { ...base, resource_type: "POSTE", poste_id: p.poste_id, machine_id: null };
    }
    return { ...base, resource_type: "MACHINE", machine_id: p.machine_id, poste_id: null };
  });

  const warnings: string[] = [];
  const deadlineMs = Date.parse(b.deadline_ts);
  const plannedEndMs = operations.length ? Date.parse(operations[operations.length - 1]!.end_ts) : Date.parse(startTs);
  if (Number.isFinite(deadlineMs) && Number.isFinite(plannedEndMs) && plannedEndMs > deadlineMs) {
    const deltaMinutes = Math.round((plannedEndMs - deadlineMs) / 60_000);
    warnings.push(`Planned end exceeds deadline by ${deltaMinutes} minutes`);
  }

  const inputJson = {
    client_id: b.client_id,
    piece_technique_id: b.piece_technique_id,
    quantity: b.quantity,
    deadline_ts: b.deadline_ts,
    start_ts: startTs,
    priority: b.priority,
  };

  const planJson = {
    priority: b.priority,
    operations,
    warnings,
  };

  const ins = await pool.query<{ id: string; expires_at: string }>(
    `
      INSERT INTO public.quick_commande_previews (
        expires_at,
        created_by,
        input_json,
        plan_json
      ) VALUES (
        now() + interval '30 minutes',
        $1,
        $2::jsonb,
        $3::jsonb
      )
      RETURNING id::text AS id, expires_at::text AS expires_at
    `,
    [params.user_id, JSON.stringify(inputJson), JSON.stringify(planJson)]
  );

  const row = ins.rows[0] ?? null;
  if (!row) throw new Error("Failed to create preview");

  return {
    preview_id: row.id,
    expires_at: row.expires_at,
    piece: {
      piece_technique_id: piece.id,
      code_piece: piece.code_piece,
      designation: piece.designation,
    },
    plan: {
      priority: b.priority,
      operations,
      warnings,
    },
  };
}

type PreviewStoredInput = {
  client_id: string;
  piece_technique_id: string;
  quantity: number;
  deadline_ts: string;
  start_ts: string;
  priority: string;
};

type PreviewStoredPlan = {
  priority: string;
  operations: QuickCommandePlannedOperation[];
  warnings?: string[];
};

async function hasCommandeToAffaireRoleColumn(db: Pick<PoolClient, "query">): Promise<boolean> {
  const res = await db.query<{ ok: number }>(
    `
      SELECT 1::int AS ok
      FROM pg_attribute
      WHERE attrelid = to_regclass('public.commande_to_affaire')
        AND attname = 'role'
        AND NOT attisdropped
      LIMIT 1
    `
  );
  return res.rows.length > 0;
}

async function insertCommandeToAffaireMapping(db: PoolClient, input: {
  commande_id: number;
  affaire_id: number;
  role: "LIVRAISON" | "PRODUCTION";
  commentaire: string | null;
}): Promise<void> {
  const hasRole = await hasCommandeToAffaireRoleColumn(db);
  if (hasRole) {
    await db.query(
      `
        INSERT INTO commande_to_affaire (commande_id, affaire_id, commentaire, role)
        VALUES ($1, $2, $3, $4)
      `,
      [input.commande_id, input.affaire_id, input.commentaire, input.role]
    );
    return;
  }

  await db.query(
    `
      INSERT INTO commande_to_affaire (commande_id, affaire_id, commentaire)
      VALUES ($1, $2, $3)
    `,
    [input.commande_id, input.affaire_id, input.commentaire]
  );
}

async function createAffaire(db: PoolClient, input: {
  commande_id: number;
  client_id: string;
  type_affaire: string;
}): Promise<number> {
  const seq = await db.query<{ id: string }>(`SELECT nextval('public.affaire_id_seq')::bigint::text AS id`);
  const rawId = seq.rows[0]?.id;
  if (!rawId) throw new Error("Failed to allocate affaire id");
  const id = toInt(rawId, "affaire.id");
  const reference = `AFF-${id}`.slice(0, 30);

  await db.query(
    `
      INSERT INTO affaire (id, reference, client_id, commande_id, devis_id, type_affaire)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [id, reference, input.client_id, input.commande_id, null, input.type_affaire]
  );

  return id;
}

async function selectPlanningConflicts(q: Pick<PoolClient, "query">, params: {
  start_ts: string;
  end_ts: string;
  poste_id: string | null;
  machine_id: string | null;
}): Promise<Array<{ id: string; start_ts: string; end_ts: string; title: string; of_numero: string | null }>> {
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  const startP = push(params.start_ts);
  const endP = push(params.end_ts);
  const where: string[] = [
    "e.archived_at IS NULL",
    "e.allow_overlap IS NOT TRUE",
    `tstzrange(e.start_ts, e.end_ts, '[)') && tstzrange(${startP}::timestamptz, ${endP}::timestamptz, '[)')`,
  ];
  if (params.poste_id) where.push(`e.poste_id = ${push(params.poste_id)}::uuid`);
  if (params.machine_id) where.push(`e.machine_id = ${push(params.machine_id)}::uuid`);

  const res = await q.query<{ id: string; start_ts: string; end_ts: string; title: string; of_numero: string | null }>(
    `
      SELECT
        e.id::text AS id,
        e.start_ts::text AS start_ts,
        e.end_ts::text AS end_ts,
        e.title,
        o.numero AS of_numero
      FROM public.planning_events e
      LEFT JOIN public.of_operations op ON op.id = e.of_operation_id
      LEFT JOIN public.ordres_fabrication o ON o.id = COALESCE(e.of_id, op.of_id)
      WHERE ${where.join(" AND ")}
      ORDER BY e.start_ts ASC, e.id ASC
      LIMIT 25
    `,
    values
  );

  return res.rows;
}

function buildEventTitle(op: { phase: number; designation: string }): string {
  const phase = Number.isFinite(op.phase) ? op.phase : 0;
  return phase > 0 ? `P${phase} - ${op.designation}` : op.designation;
}

export async function repoConfirmQuickCommande(params: {
  body: ConfirmQuickCommandeBodyDTO;
  idempotency_key: string | null;
  audit: AuditContext;
}): Promise<QuickCommandeConfirmResponse> {
  const { body: b, audit } = params;
  const client = await pool.connect();

  const requestHash = sha256(
    JSON.stringify({
      preview_id: b.preview_id,
      overrides: b.overrides,
    })
  );

  try {
    await client.query("BEGIN");

    if (params.idempotency_key) {
      try {
        await client.query(
          `
            INSERT INTO public.quick_commande_confirmations (
              idempotency_key,
              status,
              preview_id,
              request_hash,
              created_by,
              updated_by
            ) VALUES ($1, 'STARTED', $2::uuid, $3, $4, $4)
          `,
          [params.idempotency_key, b.preview_id, requestHash, audit.user_id]
        );
      } catch (err) {
        if (!isPgUniqueViolation(err)) throw err;

        const existing = await client.query<{ status: string; response_json: unknown }>(
          `
            SELECT status, response_json
            FROM public.quick_commande_confirmations
            WHERE idempotency_key = $1
            LIMIT 1
          `,
          [params.idempotency_key]
        );
        const row = existing.rows[0] ?? null;
        if (!row) throw err;
        if (row.status === "CONFIRMED" && row.response_json) {
          await client.query("COMMIT");
          return parseJsonb<QuickCommandeConfirmResponse>(row.response_json, "response_json");
        }
        throw new HttpError(409, "IDEMPOTENCY_IN_PROGRESS", "A confirmation with this Idempotency-Key already exists");
      }
    }

    const previewRes = await client.query<{
      expires_at: string;
      input_json: unknown;
      plan_json: unknown;
      confirmed_response: unknown;
    }>(
      `
        SELECT
          expires_at::text AS expires_at,
          input_json,
          plan_json,
          confirmed_response
        FROM public.quick_commande_previews
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [b.preview_id]
    );
    const preview = previewRes.rows[0] ?? null;
    if (!preview) {
      throw new HttpError(404, "PREVIEW_NOT_FOUND", "Preview not found");
    }
    if (preview.confirmed_response) {
      const resp = parseJsonb<QuickCommandeConfirmResponse>(preview.confirmed_response, "confirmed_response");
      if (params.idempotency_key) {
        await client.query(
          `
            UPDATE public.quick_commande_confirmations
            SET status = 'CONFIRMED', response_json = $2::jsonb, commande_id = $3::bigint, updated_at = now(), updated_by = $4
            WHERE idempotency_key = $1
          `,
          [params.idempotency_key, JSON.stringify(resp), resp.commande.id, audit.user_id]
        );
      }
      await client.query("COMMIT");
      return resp;
    }

    const expiresMs = Date.parse(preview.expires_at);
    if (Number.isFinite(expiresMs) && expiresMs <= Date.now()) {
      throw new HttpError(409, "PREVIEW_EXPIRED", "Preview expired; please preview again");
    }

    const input = parseJsonb<PreviewStoredInput>(preview.input_json, "input_json");
    const plan = parseJsonb<PreviewStoredPlan>(preview.plan_json, "plan_json");

    const ops = Array.isArray(plan.operations) ? [...plan.operations] : [];
    if (!ops.length) {
      throw new HttpError(409, "EMPTY_PLAN", "Preview has no operations to confirm");
    }

    const byPhase = new Map<number, QuickCommandePlannedOperation>();
    for (const o of ops) {
      byPhase.set(o.phase, o);
    }

    for (const ovr of b.overrides) {
      const current = byPhase.get(ovr.phase);
      if (!current) {
        throw new HttpError(400, "INVALID_OVERRIDE", `Unknown phase ${ovr.phase} (not present in preview plan)`);
      }

      const next: QuickCommandePlannedOperation = { ...current };

      if (ovr.poste_id) {
        next.resource_type = "POSTE";
        next.poste_id = ovr.poste_id;
        next.machine_id = null;
      }
      if (ovr.machine_id) {
        next.resource_type = "MACHINE";
        next.machine_id = ovr.machine_id;
        next.poste_id = null;
      }
      if (ovr.start_ts && ovr.end_ts) {
        next.start_ts = ovr.start_ts;
        next.end_ts = ovr.end_ts;
      }

      byPhase.set(ovr.phase, next);
    }

    const finalOps = Array.from(byPhase.values()).sort((a, b) => a.phase - b.phase);

    for (const o of finalOps) {
      const start = Date.parse(o.start_ts);
      const end = Date.parse(o.end_ts);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
        throw new HttpError(400, "INVALID_PLAN", `Invalid time range for phase ${o.phase}`);
      }
      const hasPoste = typeof o.poste_id === "string" && o.poste_id.length > 0;
      const hasMachine = typeof o.machine_id === "string" && o.machine_id.length > 0;
      if (hasPoste === hasMachine) {
        throw new HttpError(400, "INVALID_PLAN", `Missing or ambiguous resource for phase ${o.phase}`);
      }
    }

    const pieceRes = await client.query<{ id: string; code_piece: string; designation: string }>(
      `
        SELECT pt.id::text AS id, pt.code_piece, pt.designation
        FROM public.pieces_techniques pt
        WHERE pt.id = $1::uuid
          AND pt.deleted_at IS NULL
        LIMIT 1
      `,
      [input.piece_technique_id]
    );
    const piece = pieceRes.rows[0] ?? null;
    if (!piece) {
      throw new HttpError(404, "PIECE_TECHNIQUE_NOT_FOUND", "Piece technique not found");
    }

    const commandeIdRes = await client.query<{ id: string }>(
      `SELECT nextval('public.commande_client_id_seq')::bigint::text AS id`
    );
    const rawCommandeId = commandeIdRes.rows[0]?.id;
    if (!rawCommandeId) throw new Error("Failed to allocate commande id");
    const commandeId = toInt(rawCommandeId, "commande_client.id");
    const commandeNumero = `CC-${commandeId}`.slice(0, 30);

    const dateCommande = new Date().toISOString().slice(0, 10);
    if (!isIsoDate(dateCommande)) throw new Error("Failed to build date_commande");

    await client.query(
      `
        INSERT INTO commande_client (
          id,
          numero,
          client_id,
          contact_id,
          destinataire_id,
          adresse_facturation_id,
          emetteur,
          code_client,
          date_commande,
          arc_edi,
          arc_date_envoi,
          compteur_affaire_id,
          type_affaire,
          order_type,
          cadre_start_date,
          cadre_end_date,
          dest_stock_magasin_id,
          dest_stock_emplacement_id,
          mode_port_id,
          mode_reglement_id,
          conditions_paiement_id,
          biller_id,
          compte_vente_id,
          commentaire,
          remise_globale,
          total_ht,
          total_ttc
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27
        )
      `,
      [
        commandeId,
        commandeNumero,
        input.client_id,
        null,
        null,
        null,
        null,
        null,
        dateCommande,
        false,
        null,
        null,
        "fabrication",
        "FERME",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        `Quick commande (${b.preview_id})`,
        0,
        0,
        0,
      ]
    );

    await client.query(
      `
        INSERT INTO commande_ligne (
          commande_id,
          designation,
          code_piece,
          quantite,
          unite,
          prix_unitaire_ht,
          remise_ligne,
          taux_tva,
          delai_client,
          delai_interne,
          devis_numero,
          famille
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `,
      [
        commandeId,
        piece.designation,
        piece.code_piece,
        input.quantity,
        null,
        0,
        0,
        20,
        null,
        null,
        null,
        null,
      ]
    );

    const livraisonAffaireId = await createAffaire(client, {
      commande_id: commandeId,
      client_id: input.client_id,
      type_affaire: "fabrication",
    });
    await insertCommandeToAffaireMapping(client, {
      commande_id: commandeId,
      affaire_id: livraisonAffaireId,
      role: "LIVRAISON",
      commentaire: "Generated by quick-commande",
    });

    const productionAffaireId = await createAffaire(client, {
      commande_id: commandeId,
      client_id: input.client_id,
      type_affaire: "fabrication",
    });
    await insertCommandeToAffaireMapping(client, {
      commande_id: commandeId,
      affaire_id: productionAffaireId,
      role: "PRODUCTION",
      commentaire: "Generated by quick-commande",
    });

    const ofIdRes = await client.query<{ of_id: string }>(
      `SELECT nextval(pg_get_serial_sequence('public.ordres_fabrication','id'))::text AS of_id`
    );
    const rawOfId = ofIdRes.rows[0]?.of_id;
    const ofId = toInt(rawOfId, "ordres_fabrication.id");
    const ofNumero = `OF-${ofId}`;
    const ofDateFinPrevue = isoDateFromTs(input.deadline_ts);
    const ofDateLancementPrevue = isoDateFromTs(finalOps[0]?.start_ts ?? null);

    await client.query(
      `
        INSERT INTO public.ordres_fabrication (
          id,
          numero,
          affaire_id,
          commande_id,
          client_id,
          piece_technique_id,
          quantite_lancee,
          statut,
          priority,
          date_lancement_prevue,
          date_fin_prevue,
          notes,
          created_by,
          updated_by
        ) VALUES (
          $1,$2,$3::bigint,$4::bigint,$5,$6::uuid,$7,'BROUILLON'::of_status,'NORMAL'::of_priority,$8,$9,$10,$11,$11
        )
      `,
      [
        ofId,
        ofNumero,
        productionAffaireId,
        commandeId,
        input.client_id,
        piece.id,
        input.quantity,
        ofDateLancementPrevue,
        ofDateFinPrevue,
        `Generated by quick-commande preview ${b.preview_id}`,
        audit.user_id,
      ]
    );

    const ofOpsRes = await client.query<{ id: string; phase: number; designation: string; temps_total_planned: number }>(
      `
        INSERT INTO public.of_operations (
          of_id,
          phase,
          designation,
          cf_id,
          poste_id,
          machine_id,
          hourly_rate_applied,
          tp,
          tf_unit,
          qte,
          coef,
          temps_total_planned,
          status,
          notes
        )
        SELECT
          $1::bigint AS of_id,
          pto.phase,
          pto.designation,
          pto.cf_id,
          NULL::uuid AS poste_id,
          NULL::uuid AS machine_id,
          COALESCE(pto.taux_horaire, 0)::numeric(12,2) AS hourly_rate_applied,
          COALESCE(pto.tp, 0)::numeric(12,3) AS tp,
          COALESCE(pto.tf_unit, 0)::numeric(12,3) AS tf_unit,
          COALESCE(pto.qte, 1)::numeric(12,3) AS qte,
          COALESCE(pto.coef, 1)::numeric(10,3) AS coef,
          ROUND((COALESCE(pto.tp,0) + COALESCE(pto.tf_unit,0) * COALESCE(pto.qte,1)) * COALESCE(pto.coef,1), 3)::numeric(12,3) AS temps_total_planned,
          'TODO'::of_operation_status AS status,
          pto.designation_2 AS notes
        FROM public.pieces_techniques_operations pto
        WHERE pto.piece_technique_id = $2::uuid
        ORDER BY pto.phase ASC, pto.id ASC
        RETURNING id::text AS id, phase::int AS phase, designation, temps_total_planned::float8 AS temps_total_planned
      `,
      [ofId, piece.id]
    );

    const insertedOps = ofOpsRes.rows;
    const insertedPhaseSet = new Set(insertedOps.map((x) => x.phase));
    const plannedPhaseSet = new Set(finalOps.map((x) => x.phase));
    if (insertedPhaseSet.size !== plannedPhaseSet.size) {
      throw new HttpError(409, "PREVIEW_OUTDATED", "Piece technique operations changed; please preview again");
    }
    for (const ph of insertedPhaseSet) {
      if (!plannedPhaseSet.has(ph)) {
        throw new HttpError(409, "PREVIEW_OUTDATED", "Piece technique operations changed; please preview again");
      }
    }

    const opByPhase = new Map<number, { id: string; phase: number; designation: string }>();
    for (const op of insertedOps) {
      opByPhase.set(op.phase, { id: op.id, phase: op.phase, designation: op.designation });
    }

    const planningEventIds: string[] = [];

    for (const plannedOp of finalOps) {
      const op = opByPhase.get(plannedOp.phase);
      if (!op) {
        throw new HttpError(409, "PREVIEW_OUTDATED", "Missing OF operation for a planned phase; please preview again");
      }

      const posteId = plannedOp.resource_type === "POSTE" ? plannedOp.poste_id : null;
      const machineId = plannedOp.resource_type === "MACHINE" ? plannedOp.machine_id : null;

      // Ensure operation carries the same resource selection (helps later edits by opId).
      await client.query(
        `
          UPDATE public.of_operations
          SET poste_id = $2::uuid,
              machine_id = $3::uuid,
              updated_at = now()
          WHERE id = $1::uuid
        `,
        [op.id, posteId, machineId]
      );

      const conflicts = await selectPlanningConflicts(client, {
        start_ts: plannedOp.start_ts,
        end_ts: plannedOp.end_ts,
        poste_id: posteId,
        machine_id: machineId,
      });
      if (conflicts.length) {
        throw new HttpError(409, "PLANNING_CONFLICT", "Resource has conflicting events", { conflicts });
      }

      const eventId = crypto.randomUUID();
      const title = buildEventTitle(op);
      await client.query(
        `
          INSERT INTO public.planning_events (
            id,
            kind,
            status,
            priority,
            of_id,
            of_operation_id,
            machine_id,
            poste_id,
            title,
            description,
            start_ts,
            end_ts,
            allow_overlap,
            created_by,
            updated_by
          ) VALUES (
            $1,
            'OF_OPERATION'::planning_event_kind,
            'PLANNED'::planning_event_status,
            $2::planning_priority,
            $3::bigint,
            $4::uuid,
            $5::uuid,
            $6::uuid,
            $7,
            $8,
            $9::timestamptz,
            $10::timestamptz,
            false,
            $11,
            $11
          )
        `,
        [
          eventId,
          input.priority === "LOW" || input.priority === "HIGH" || input.priority === "CRITICAL" ? input.priority : "NORMAL",
          ofId,
          op.id,
          machineId,
          posteId,
          title,
          null,
          plannedOp.start_ts,
          plannedOp.end_ts,
          audit.user_id,
        ]
      );

      planningEventIds.push(eventId);
    }

    const response: QuickCommandeConfirmResponse = {
      preview_id: b.preview_id,
      commande: { id: commandeId, numero: commandeNumero },
      affaires: { livraison_affaire_id: livraisonAffaireId, production_affaire_id: productionAffaireId },
      of: { id: ofId, numero: ofNumero },
      planning_event_ids: planningEventIds,
    };

    await client.query(
      `
        UPDATE public.quick_commande_previews
        SET confirmed_at = now(),
            confirmed_by = $2,
            confirmed_commande_id = $3::bigint,
            confirmed_response = $4::jsonb
        WHERE id = $1::uuid
      `,
      [b.preview_id, audit.user_id, commandeId, JSON.stringify(response)]
    );

    if (params.idempotency_key) {
      await client.query(
        `
          UPDATE public.quick_commande_confirmations
          SET status = 'CONFIRMED',
              response_json = $2::jsonb,
              commande_id = $3::bigint,
              updated_at = now(),
              updated_by = $4
          WHERE idempotency_key = $1
        `,
        [params.idempotency_key, JSON.stringify(response), commandeId, audit.user_id]
      );
    }

    await repoInsertAuditLog({
      user_id: audit.user_id,
      body: {
        event_type: "ACTION",
        action: "quick-commande.confirm",
        page_key: audit.page_key,
        entity_type: "commande_client",
        entity_id: String(commandeId),
        path: audit.path,
        client_session_id: audit.client_session_id,
        details: {
          preview_id: b.preview_id,
          commande_id: commandeId,
          of_id: ofId,
          planning_event_ids: planningEventIds,
          idempotency_key: params.idempotency_key,
        },
      },
      ip: audit.ip,
      user_agent: audit.user_agent,
      device_type: audit.device_type,
      os: audit.os,
      browser: audit.browser,
      tx: client,
    });

    await client.query("COMMIT");
    return response;
  } catch (err) {
    await client.query("ROLLBACK");
    if (params.idempotency_key) {
      try {
        await pool.query(
          `
            UPDATE public.quick_commande_confirmations
            SET status = 'FAILED', updated_at = now()
            WHERE idempotency_key = $1
              AND status = 'STARTED'
          `,
          [params.idempotency_key]
        );
      } catch {
        // ignore
      }
    }
    throw err;
  } finally {
    client.release();
  }
}
