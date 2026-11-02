import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { z } from "zod";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { centralCanonicalJson } from "../../planning/domain/central-canonical-json";
import { demandImportCompositeKey } from "../../demand-import/demand-import.adapter";
import type { demandRowSchema } from "../validators/demand-pilot.validators";
import {
  assertDemandSiteAccess,
  resolveDemandRow,
} from "./demand-pilot.repository";

type Row = z.infer<typeof demandRowSchema>;
type Actor = { userId?: number; portalAccountId?: string };
type Batch = {
  clientId: string;
  rows: Row[];
  sourceFileName?: string | null;
  completeSnapshot?: boolean;
  actor: Actor;
  idempotencyKey: string;
};
type Prior = {
  id: string;
  revision_no: number;
  diff_type: string;
  after_snapshot: Row;
};
type Outcome = { created: number; unchanged: number; missing: number };
const digest = (v: unknown) =>
  createHash("sha256").update(centralCanonicalJson(v)).digest("hex");
export function lockDemandSite(
  tx: Pick<PoolClient, "query">,
  clientId: string,
  site: string,
) {
  return tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    centralCanonicalJson(["demand-site", clientId, site]),
  ]);
}
function normalized(row: Row): Row {
  return {
    ...row,
    source_as_of: new Date(row.source_as_of).toISOString(),
    unit: row.unit.toUpperCase(),
    quantity_basis: row.quantity_basis ?? "TOTAL",
    article_code: row.article_code ?? null,
    article_id: row.article_id ?? null,
    contract_id: row.contract_id ?? null,
    contract_line_id: row.contract_line_id ?? null,
    customer_reference: row.customer_reference ?? null,
    comment: row.comment ?? null,
  };
}
function sameBusinessData(a: Row, b: Row) {
  const business = (row: Row) => {
    const { source_version, source_as_of, ...data } = normalized(row);
    const value = data as Record<string, unknown>;
    delete value.source_article_code;
    delete value.source_unit;
    delete value.source_quantity;
    return value;
  };
  return (
    centralCanonicalJson(business(a)) === centralCanonicalJson(business(b))
  );
}
async function appendRevision(
  tx: PoolClient,
  p: Batch,
  importId: string,
  source: Row,
  prior: Prior | undefined,
  absent: boolean,
  raw?: Row,
) {
  const id = randomUUID(),
    after = {
      ...normalized(source),
      ...(raw
        ? {
            source_article_code: raw.article_code,
            source_unit: raw.unit,
            source_quantity: raw.quantity,
          }
        : {}),
    },
    kind = absent ? "REMOVED" : prior ? "CHANGED" : "NEW";
  const reason = absent
    ? "Échéance absente du relevé complet. Vérifier le reliquat et contacter le client."
    : null;
  await tx.query(
    `INSERT INTO public.demand_pilot_revisions(id,import_id,client_id,external_site,external_order_key,external_line_key,external_schedule_key,
 source_version,source_as_of,kind,quantity,unit,quantity_basis,need_date,article_code,article_id,contract_id,contract_line_id,customer_reference,comment,
 revision_no,diff_type,status,decision_reason,before_snapshot,after_snapshot,supersedes_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
    [
      id,
      importId,
      p.clientId,
      after.external_site,
      after.external_order_key,
      after.external_line_key,
      after.external_schedule_key,
      after.source_version,
      after.source_as_of,
      after.kind,
      after.quantity,
      after.unit,
      after.quantity_basis,
      after.need_date,
      after.article_code,
      after.article_id,
      after.contract_id,
      after.contract_line_id,
      after.customer_reference,
      after.comment,
      (prior?.revision_no ?? 0) + 1,
      kind,
      absent ? "REVIEW" : "PENDING",
      reason,
      prior ? JSON.stringify(prior.after_snapshot) : null,
      JSON.stringify(after),
      prior?.id ?? null,
    ],
  );
  await tx.query(
    `INSERT INTO public.demand_pilot_events(revision_id,import_id,actor_user_id,actor_portal_account_id,idempotency_key,request_hash,action,payload)
 VALUES($1,$2,$3,$4,$5,$6,'IMPORT',$7)`,
    [
      id,
      importId,
      p.actor.userId ?? null,
      p.actor.portalAccountId ?? null,
      randomUUID(),
      digest([importId, id]),
      JSON.stringify({ diff_type: kind }),
    ],
  );
}
export async function importDemand(p: Batch) {
  const actor = p.actor.userId
    ? "user:" + p.actor.userId
    : p.actor.portalAccountId
      ? "portal:" + p.actor.portalAccountId
      : null;
  if (!actor || !!p.actor.userId === !!p.actor.portalAccountId)
    throw new HttpError(
      401,
      "DEMAND_PILOT_ACTOR_REQUIRED",
      "Un acteur authentifié est requis.",
    );
  if (!p.rows.length || p.rows.length > 5000)
    throw new HttpError(
      422,
      "DEMAND_PILOT_IMPORT_SIZE",
      "Un import doit comprendre 1 à 5 000 échéances.",
    );
  const ordered = p.rows
    .map(normalized)
    .sort((a, b) =>
      demandImportCompositeKey(a).localeCompare(demandImportCompositeKey(b)),
    );
  const keys = new Set(ordered.map(demandImportCompositeKey));
  if (keys.size !== ordered.length)
    throw new HttpError(
      422,
      "DEMAND_PILOT_DUPLICATE_KEY",
      "Clé d’échéance dupliquée.",
    );
  const {
    external_site: site,
    source_version: version,
    source_as_of: asOf,
  } = ordered[0];
  if (
    ordered.some(
      (r) =>
        r.external_site !== site ||
        r.source_version !== version ||
        r.source_as_of !== asOf,
    )
  )
    throw new HttpError(
      422,
      "DEMAND_PILOT_IMPORT_SCOPE",
      "Un import couvre un seul site, une version et un horodatage.",
    );
  const hash = digest({
    client: p.clientId,
    complete: !!p.completeSnapshot,
    rows: ordered,
  });
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await lockDemandSite(tx, p.clientId, site);
    if (p.actor.portalAccountId)
      await assertDemandSiteAccess(
        tx,
        p.clientId,
        p.actor.portalAccountId,
        site,
      );
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      centralCanonicalJson([actor, p.idempotencyKey]),
    ]);
    const old = (
      await tx.query<{ request_hash: string; id: string; outcome: Outcome }>(
        `SELECT r.request_hash,i.id,i.outcome FROM public.demand_pilot_import_requests r
   JOIN public.demand_pilot_imports i ON i.id=r.import_id WHERE r.actor=$1 AND r.idempotency_key=$2`,
        [actor, p.idempotencyKey],
      )
    ).rows[0];
    if (old && old.request_hash !== hash)
      throw new HttpError(
        409,
        "DEMAND_KEY_CONFLICT",
        "Cette tentative a déjà été utilisée avec un contenu différent.",
      );
    const seen =
      old ??
      (
        await tx.query<{ id: string; request_hash: string; outcome: Outcome }>(
          `SELECT id,request_hash,outcome FROM public.demand_pilot_imports
    WHERE client_id=$1 AND external_site=$2 AND source_version=$3`,
          [p.clientId, site, version],
        )
      ).rows[0];
    const recordKey = (id: string) =>
      tx.query(
        "INSERT INTO public.demand_pilot_import_requests(actor,idempotency_key,request_hash,import_id) VALUES($1,$2,$3,$4)",
        [actor, p.idempotencyKey, hash, id],
      );
    if (seen) {
      if (seen.request_hash !== hash)
        throw new HttpError(
          409,
          "SOURCE_VERSION_CONFLICT",
          "Deux contenus différents portent la même version source.",
        );
      if (!old) await recordKey(seen.id);
      await tx.query("COMMIT");
      return { replayed: true, import_id: seen.id, ...seen.outcome };
    }
    if (
      (
        await tx.query(
          "SELECT 1 FROM public.demand_pilot_imports WHERE client_id=$1 AND external_site=$2 AND source_as_of >= $3 LIMIT 1",
          [p.clientId, site, asOf],
        )
      ).rowCount
    )
      throw new HttpError(
        409,
        "DEMAND_PILOT_STALE",
        "Une version plus récente ou simultanée est déjà enregistrée.",
      );
    const previous = (
      await tx.query<Prior>(
        `SELECT DISTINCT ON(external_order_key,external_line_key,external_schedule_key) id,revision_no,diff_type,after_snapshot
    FROM public.demand_pilot_revisions WHERE client_id=$1 AND external_site=$2 ORDER BY external_order_key,external_line_key,external_schedule_key,revision_no DESC`,
        [p.clientId, site],
      )
    ).rows;
    const priorByKey = new Map(
      previous.map((r) => [demandImportCompositeKey(r.after_snapshot), r]),
    );
    const importId = randomUUID();
    await tx.query(
      `INSERT INTO public.demand_pilot_imports(id,client_id,external_site,source_version,source_as_of,request_hash,submitted_by_user_id,
  submitted_by_portal_account_id,source_file_name,snapshot_complete,row_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        importId,
        p.clientId,
        site,
        version,
        asOf,
        hash,
        p.actor.userId ?? null,
        p.actor.portalAccountId ?? null,
        p.sourceFileName ?? null,
        !!p.completeSnapshot,
        ordered.length,
      ],
    );
    const outcome: Outcome = { created: 0, unchanged: 0, missing: 0 };
    for (const raw of ordered) {
      const row = await resolveDemandRow(tx, p.clientId, raw),
        prior = priorByKey.get(demandImportCompositeKey(row));
      if (
        prior &&
        prior.diff_type !== "REMOVED" &&
        sameBusinessData(prior.after_snapshot, row)
      ) {
        outcome.unchanged++;
        continue;
      }
      await appendRevision(tx, p, importId, row, prior, false, raw);
      outcome.created++;
    }
    if (p.completeSnapshot)
      for (const [key, prior] of priorByKey) {
        if (keys.has(key) || prior.diff_type === "REMOVED") continue;
        await appendRevision(
          tx,
          p,
          importId,
          {
            ...prior.after_snapshot,
            source_version: version,
            source_as_of: asOf,
          },
          prior,
          true,
        );
        outcome.missing++;
      }
    await tx.query(
      "UPDATE public.demand_pilot_imports SET outcome=$2 WHERE id=$1",
      [importId, JSON.stringify(outcome)],
    );
    await recordKey(importId);
    await tx.query("COMMIT");
    return { replayed: false, import_id: importId, ...outcome };
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}
