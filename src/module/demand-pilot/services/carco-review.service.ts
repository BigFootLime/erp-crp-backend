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
  actor: number,
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
      (id,client_id,external_site,source_version,source_as_of,content_sha256,source_file_name,complete_snapshot,preview,received_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
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
        actor,
      ],
    );
    return id;
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
    return { review, previous, isLatest: current?.id === review.id };
  }, "REPEATABLE READ");
  if (!pair) return null;
  const { review, previous, isLatest } = pair;
  const qualified = await qualifyDemandPreview(
    scope.clientId,
    scope.site,
    structuredClone(review.preview),
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
