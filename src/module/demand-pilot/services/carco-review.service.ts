import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { industrialTx } from "../../planning/services/industrial-runs.service";
import {
  demandImportCompositeKey,
  parseDemandImportFile,
} from "../../demand-import/demand-import.adapter";
import type { DemandImportResult } from "../../demand-import/types";
import {
  lockDemandSite,
  importDemand,
} from "../repository/demand-ingest.repository";
import { qualifyDemandPreview } from "./demand-preview.service";
import { compareCarco } from "./carco-comparison";
import { observedCarcoSplit } from "./carco-qualification";
import { demandRowSchema } from "../validators/demand-pilot.validators";
import { assertDemandSiteAccess } from "../repository/demand-pilot.repository";

type Review = {
  id: string;
  client_id: string;
  external_site: string;
  source_version: string;
  source_as_of: Date;
  source_file_name: string;
  complete_snapshot: boolean;
  content_sha256: string;
  preview: DemandImportResult;
};
type Scope = { clientId: string; site: string };
export async function listPortalCarcoDeposits(
  clientId: string,
  accountId: string,
) {
  return industrialTx(
    async (tx) =>
      (
        await tx.query(
          `SELECT r.id,r.external_site,r.source_version,r.received_at
    FROM public.carco_reviews r
    JOIN public.client_portal_accounts a ON a.id=r.received_portal_account_id AND a.client_id=r.client_id
    JOIN public.client_portal_demand_sites s ON s.portal_account_id=a.id AND s.external_site=r.external_site
    WHERE r.client_id=$1 AND a.id=$2 AND a.status='ACTIVE'
    ORDER BY r.received_at DESC,r.id LIMIT 10`,
          [clientId, accountId],
        )
      ).rows,
  );
}
export async function portalCarcoSites(clientId: string, accountId: string) {
  return industrialTx(async (tx) =>
    (
      await tx.query<{ external_site: string }>(
        `SELECT s.external_site
    FROM public.client_portal_demand_sites s JOIN public.client_portal_accounts a ON a.id=s.portal_account_id
    WHERE a.id=$1 AND a.client_id=$2 AND a.status='ACTIVE' ORDER BY s.external_site`,
        [accountId, clientId],
      )
    ).rows.map((r) => r.external_site),
  );
}
export async function listCarcoDeposits(clientId: string | null, page: number) {
  return industrialTx(async (tx) => {
    const { rows } = await tx.query(
      `SELECT * FROM (
        SELECT DISTINCT ON (r.client_id,r.external_site) r.client_id,c.company_name,r.external_site,
          r.source_version,r.received_at,r.received_portal_account_id IS NOT NULL AS from_portal
        FROM public.carco_reviews r JOIN public.clients c ON c.client_id=r.client_id
        WHERE ($1::text IS NULL OR r.client_id=$1)
        ORDER BY r.client_id,r.external_site,r.source_as_of DESC
      ) latest ORDER BY received_at DESC,client_id,external_site LIMIT 11 OFFSET $2`,
      [clientId, (page - 1) * 10],
    );
    return { items: rows.slice(0, 10), has_more: rows.length > 10 };
  });
}
async function latest(tx: PoolClient, scope: Scope) {
  return (
    await tx.query<Review>(
      `SELECT * FROM public.carco_reviews WHERE client_id=$1 AND external_site=$2
    ORDER BY source_as_of DESC LIMIT 1`,
      [scope.clientId, scope.site],
    )
  ).rows[0];
}
async function reviewAt(tx: PoolClient, scope: Scope, id: string) {
  const row = (
    await tx.query<Review>(
      "SELECT * FROM public.carco_reviews WHERE id=$1 AND client_id=$2 AND external_site=$3",
      [id, scope.clientId, scope.site],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(
      404,
      "CARCO_NOT_FOUND",
      "Relevé introuvable pour ce client et ce site.",
    );
  return row;
}

export async function recordCarco(
  scope: Scope,
  version: string,
  asOf: string,
  complete: boolean,
  file: Express.Multer.File,
  actor: number | { portalAccountId: string },
) {
  const parsed = parseDemandImportFile({
    source: "VISION_SYSTEMS",
    file,
    defaults: {
      external_site: scope.site,
      source_version: version,
      source_as_of: asOf,
    },
  });
  if (!parsed.summary.total || parsed.summary.total > 5000)
    throw new HttpError(
      422,
      "CARCO_SIZE",
      "Le relevé doit contenir entre 1 et 5 000 lignes.",
    );
  if (
    parsed.preview_rows.some(
      ({ candidate: c }) =>
        c.external_site !== scope.site ||
        c.source_version !== version ||
        !c.source_as_of ||
        Date.parse(c.source_as_of) !== Date.parse(asOf),
    )
  )
    throw new HttpError(
      422,
      "CARCO_MIXED_SCOPE",
      "Les lignes doivent appartenir au site et à la version de cet envoi.",
    );
  const hash = createHash("sha256").update(file.buffer).digest("hex");
  return industrialTx(async (tx) => {
    await lockDemandSite(tx, scope.clientId, scope.site);
    if (typeof actor !== "number")
      await assertDemandSiteAccess(
        tx,
        scope.clientId,
        actor.portalAccountId,
        scope.site,
      );
    const current = await latest(tx, scope);
    const previousVersion = (
      await tx.query<Review>(
        "SELECT * FROM public.carco_reviews WHERE client_id=$1 AND external_site=$2 AND source_version=$3",
        [scope.clientId, scope.site, version],
      )
    ).rows[0];
    if (previousVersion) {
      if (
        previousVersion.content_sha256 !== hash ||
        previousVersion.complete_snapshot !== complete ||
        +previousVersion.source_as_of !== Date.parse(asOf)
      )
        throw new HttpError(
          409,
          "CARCO_VERSION_CONFLICT",
          "Cette version désigne déjà un autre envoi ou un autre périmètre.",
        );
      return previousVersion.id;
    }
    if (current && Date.parse(asOf) <= +current.source_as_of)
      throw new HttpError(
        409,
        "CARCO_STALE",
        "Un relevé plus récent ou simultané est déjà enregistré.",
      );
    if (
      (
        await tx.query(
          "SELECT 1 FROM public.demand_pilot_imports WHERE client_id=$1 AND external_site=$2 AND source_as_of>$3 LIMIT 1",
          [scope.clientId, scope.site, asOf],
        )
      ).rowCount
    )
      throw new HttpError(
        409,
        "CARCO_STALE",
        "Une demande plus récente est déjà enregistrée pour ce site.",
      );
    // A later, genuinely dated export advances the site watermark even when its
    // contents are identical. The business revision writer skips unchanged rows.
    const id = randomUUID();
    await tx.query(
      `INSERT INTO public.carco_reviews
      (id,client_id,external_site,source_version,source_as_of,content_sha256,source_file_name,complete_snapshot,preview,received_by,received_portal_account_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
      [
        id,
        scope.clientId,
        scope.site,
        version,
        asOf,
        hash,
        file.originalname,
        complete,
        JSON.stringify(parsed),
        typeof actor === "number" ? actor : null,
        typeof actor === "number" ? null : actor.portalAccountId,
      ],
    );
    return id;
  });
}

export async function bindReviewContract(
  scope: Scope,
  reviewId: string,
  contractId: string,
  actor: number,
) {
  return industrialTx(async (tx) => {
    await lockDemandSite(tx, scope.clientId, scope.site);
    if ((await latest(tx, scope))?.id !== reviewId)
      throw new HttpError(
        409,
        "CARCO_STALE",
        "Choisissez le dernier relevé du site.",
      );
    const match = (
      await tx.query<{ reference: string }>(
        `SELECT reference FROM public.client_contracts
      WHERE id=$1 AND client_id=$2 AND status='ACTIVE' FOR SHARE`,
        [contractId, scope.clientId],
      )
    ).rows[0];
    if (!match)
      throw new HttpError(
        422,
        "CARCO_CONTRACT_SCOPE",
        "Choisissez un contrat actif de ce client.",
      );
    await tx.query(
      `INSERT INTO public.carco_review_contracts(review_id,contract_id,reference_at_binding,bound_by)
      VALUES($1,$2,$3,$4) ON CONFLICT (review_id) DO NOTHING`,
      [reviewId, contractId, match.reference, actor],
    );
    const saved = await tx.query(
      "SELECT 1 FROM public.carco_review_contracts WHERE review_id=$1 AND contract_id=$2",
      [reviewId, contractId],
    );
    if (!saved.rowCount)
      throw new HttpError(
        409,
        "CARCO_CONTRACT_ALREADY_BOUND",
        "Ce relevé a déjà été rattaché à un autre contrat.",
      );
  });
}

export async function qualifyOpenSchedule(
  scope: Scope,
  id: string,
  row: number,
  kind: "FIRM" | "FORECAST",
  schedule: string,
  actor: number,
) {
  return industrialTx(async (tx) => {
    await lockDemandSite(tx, scope.clientId, scope.site);
    const review = await latest(tx, scope);
    if (review?.id !== id)
      throw new HttpError(409, "CARCO_STALE", "Le relevé a changé.");
    const line = review.preview.preview_rows.find((l) => l.row_number === row);
    const c = line?.candidate;
    if (
      !c ||
      c.kind ||
      !c.external_order_key ||
      !c.external_line_key ||
      line?.source?.order_type?.trim().toLowerCase() !== "cde ouverte" ||
      (c.external_schedule_key && c.external_schedule_key !== schedule)
    )
      throw new HttpError(
        422,
        "CARCO_KIND_SOURCE",
        "Seule la nature manquante d’une échéance ouverte peut être précisée.",
      );
    if (!c.external_schedule_key) {
      const split = await tx.query(
        `SELECT 1 FROM public.carco_reviews r
        CROSS JOIN LATERAL jsonb_array_elements(r.preview->'preview_rows') l
        WHERE r.client_id=$1 AND r.external_site=$2 AND l->'candidate'->>'external_order_key'=$3
          AND l->'candidate'->>'external_line_key'=$4 GROUP BY r.id HAVING count(*)>1 LIMIT 1`,
        [scope.clientId, scope.site, c.external_order_key, c.external_line_key],
      );
      if (split.rowCount)
        throw new HttpError(
          409,
          "CARCO_BIND_AMBIGUOUS",
          "Cette ligne a plusieurs échéances. Demandez leurs identifiants au client.",
        );
    }
    await tx.query(
      `INSERT INTO public.carco_review_schedule_decisions(review_id,row_number,kind,schedule_key,decided_by)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [id, row, kind, schedule, actor],
    );
    const recorded = await tx.query(
      "SELECT 1 FROM public.carco_review_schedule_decisions WHERE review_id=$1 AND row_number=$2 AND kind=$3 AND schedule_key=$4",
      [id, row, kind, schedule],
    );
    if (!recorded.rowCount)
      throw new HttpError(
        409,
        "CARCO_KIND_CONFLICT",
        "Une décision différente existe déjà pour cette échéance.",
      );
  });
}

export async function getCarco(scope: Scope, id?: string) {
  const pair = await industrialTx(async (tx) => {
    const current = await latest(tx, scope);
    const review = id ? await reviewAt(tx, scope, id) : current;
    if (!review) return null;
    const previous = (
      await tx.query<Review>(
        `SELECT * FROM public.carco_reviews WHERE client_id=$1 AND external_site=$2
      AND source_as_of<$3 ORDER BY source_as_of DESC LIMIT 1`,
        [scope.clientId, scope.site, review.source_as_of],
      )
    ).rows[0];
    const binding = (
      await tx.query<{ contract_id: string; reference: string }>(
        `SELECT b.contract_id,c.reference FROM public.carco_review_contracts b
      JOIN public.client_contracts c ON c.id=b.contract_id AND c.client_id=$2 WHERE b.review_id=$1`,
        [review.id, scope.clientId],
      )
    ).rows[0];
    const decisions = (
      await tx.query<{
        row_number: number;
        kind: "FIRM" | "FORECAST";
        schedule_key: string;
      }>(
        "SELECT row_number,kind,schedule_key FROM public.carco_review_schedule_decisions WHERE review_id=$1",
        [review.id],
      )
    ).rows;
    return {
      review,
      previous,
      binding,
      decisions,
      isLatest: current?.id === review.id,
    };
  }, "REPEATABLE READ");
  if (!pair) return null;
  const { review, previous, isLatest } = pair;
  const preview = structuredClone(review.preview);
  const decisions = new Map(pair.decisions.map((d) => [d.row_number, d]));
  for (const line of preview.preview_rows) {
    const decision = decisions.get(line.row_number);
    if (!decision) continue;
    line.candidate.kind = decision.kind;
    line.candidate.external_schedule_key = decision.schedule_key;
    line.diagnostics = line.diagnostics.filter(
      (d) =>
        d.code !== "FIRMNESS_REQUIRED" &&
        !(
          d.code === "REQUIRED_FIELD_MISSING" &&
          ["kind", "external_schedule_key"].includes(d.field ?? "")
        ),
    );
  }
  if (pair.binding)
    for (const line of preview.preview_rows) {
      const c = line.candidate;
      if (
        !c.contract_reference &&
        (c.kind === "FORECAST" ||
          line.source?.order_type?.trim().toLowerCase() === "cde ouverte")
      ) {
        c.contract_reference = pair.binding.reference;
        line.diagnostics = line.diagnostics.filter(
          (d) => d.code !== "OPEN_CONTRACT_REQUIRED",
        );
      }
    }
  const qualified = await qualifyDemandPreview(
    scope.clientId,
    scope.site,
    preview,
    undefined,
    true,
  );
  const differences = compareCarco(
    review.preview.preview_rows,
    previous?.preview.preview_rows ?? [],
    review.complete_snapshot,
  );
  const qualificationHash = createHash("sha256")
    .update(
      JSON.stringify(
        qualified.preview_rows.map((l) => [
          l.row_number,
          l.candidate.external_schedule_key,
          l.candidate.kind,
          l.candidate.contract_reference,
          l.resolved,
          l.diagnostics.map((d) => [d.code, d.field]),
        ]),
      ),
    )
    .digest("hex");
  return {
    id: review.id,
    version: review.source_version,
    as_of: review.source_as_of,
    previous_version: previous?.source_version ?? null,
    default_contract: pair.binding ?? null,
    complete: review.complete_snapshot,
    latest: isLatest,
    file: review.source_file_name,
    summary: qualified.summary,
    lines: qualified.preview_rows,
    differences,
    ready: qualified.rows,
    qualification_hash: qualificationHash,
  };
}

export async function bindCarco(
  scope: Scope,
  id: string,
  rowNumber: number,
  schedule: string,
  actor: number,
) {
  return industrialTx(async (tx) => {
    await lockDemandSite(tx, scope.clientId, scope.site);
    const review = await reviewAt(tx, scope, id);
    const c = review.preview.preview_rows.find(
      (r) => r.row_number === rowNumber,
    )?.candidate;
    if (
      (await latest(tx, scope))?.id !== id ||
      !c?.article_code ||
      !c.external_line_key ||
      !c.external_order_key ||
      c.kind !== "FIRM" ||
      c.external_schedule_key ||
      review.preview.preview_rows.filter(
        (r) =>
          r.candidate.external_order_key === c.external_order_key &&
          r.candidate.external_line_key === c.external_line_key,
      ).length !== 1
    )
      throw new HttpError(
        409,
        "CARCO_BIND_AMBIGUOUS",
        "La correspondance exige une seule échéance ferme pour cette ligne du dernier relevé.",
      );
    const params = [
      scope.clientId,
      scope.site,
      c.external_order_key,
      c.external_line_key,
      c.article_code,
      schedule,
      actor,
    ];
    const result = await tx.query(
      `INSERT INTO public.carco_schedule_bindings
      (client_id,external_site,order_key,line_key,article_code,schedule_key,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT DO NOTHING RETURNING schedule_key`,
      params,
    );
    if (
      (
        await tx.query(
          `SELECT 1 FROM public.carco_schedule_bindings b WHERE client_id=$1 AND external_site=$2 AND order_key=$3 AND line_key=$4 AND ${observedCarcoSplit}`,
          params.slice(0, 4),
        )
      ).rowCount
    )
      throw new HttpError(
        409,
        "CARCO_PREVIOUS_SPLIT",
        "Cette ligne a déjà été fractionnée. Obtenez les identifiants d’échéance du client.",
      );
    if (
      !result.rowCount &&
      !(
        await tx.query(
          "SELECT 1 FROM public.carco_schedule_bindings WHERE client_id=$1 AND external_site=$2 AND order_key=$3 AND line_key=$4 AND article_code=$5 AND schedule_key=$6",
          params.slice(0, 6),
        )
      ).rowCount
    )
      throw new HttpError(
        409,
        "CARCO_BIND_CONFLICT",
        "Cette ligne possède déjà une autre correspondance. Vérifier son historique.",
      );
  });
}

export async function submitCarco(
  scope: Scope,
  id: string,
  actor: number,
  key: string,
  expectedHash?: string,
) {
  const review = await getCarco(scope, id);
  if (!review?.latest || !review.ready.length)
    throw new HttpError(
      409,
      "CARCO_NOT_READY",
      "Aucune échéance qualifiée dans le dernier relevé.",
    );
  if (expectedHash && expectedHash !== review.qualification_hash)
    throw new HttpError(
      409,
      "CARCO_REVIEW_CHANGED",
      "La qualification a changé depuis l’aperçu. Revérifiez le relevé.",
    );
  return importDemand({
    clientId: scope.clientId,
    rows: review.ready.map((r) => demandRowSchema.parse(r)),
    actor: { userId: actor },
    expectedMappings: new Map(
      review.lines.flatMap((l) => {
        const row = demandRowSchema.safeParse(l.candidate);
        return l.resolved && row.success
          ? [[demandImportCompositeKey(row.data), l.resolved] as const]
          : [];
      }),
    ),
    sourceFileName: review.file,
    completeSnapshot: review.complete && review.summary.invalid === 0,
    idempotencyKey: key,
    carcoReviewId: id,
  });
}
