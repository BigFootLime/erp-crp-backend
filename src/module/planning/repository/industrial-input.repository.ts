import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import type {
  IndustrialArticle,
  IndustrialBom,
  IndustrialContractRule,
  IndustrialDemand,
  IndustrialInput,
  IndustrialSource,
} from "../types/industrial-plan.types";
import { readContractCoverageDemands } from "../../client/repository/client-contract-coverage.repository";
import { readContractCoverageStock } from "../../client/repository/client-contract-coverage-stock.repository";
import { readContractCoverageProduction } from "../../client/repository/client-contract-coverage-production.repository";
import { readFutureMaterialSupplyTx } from "../../production/repository/material-future-supply.repository";
import { readIndustrialPolicy } from "./industrial-policy.repository";
import { historySuggestions } from "./industrial-history.repository";
import {
  expandPilotForecasts,
  consumeGrossForecasts,
} from "./industrial-forecast.repository";

type Db = Pick<PoolClient, "query">;
type ArticleRow = IndustrialArticle & {
  root: string;
  version: string | null;
  piece: string | null;
};
const tooLarge = () =>
  new HttpError(
    422,
    "INDUSTRIAL_SCOPE_TOO_LARGE",
    "Le périmètre dépasse les limites du pilote. Aucun plan partiel n’a été produit.",
  );
const catalogSql = `SELECT a.id::text,COALESCE(a.root_article_id,a.id)::text AS root,a.code,upper(btrim(a.unite)) AS unit,
 COALESCE(r.family,a.family_code,a.article_type) AS family, CASE WHEN a.piece_technique_id IS NOT NULL THEN 'MAKE'
 WHEN a.article_category='traitement' THEN 'SUBCONTRACT' ELSE 'BUY' END AS kind,
 a.piece_technique_id::text AS piece,v.id::text AS version,r.lead_days AS "leadDays",COALESCE(r.lot_size,sl.lot)::text AS lot,
 r.unit_cost_eur::text AS cost,
 CASE WHEN a.piece_technique_id IS NOT NULL
             AND (r.article_id IS NULL OR r.yield_qualified_at IS NULL)
      THEN NULL ELSE COALESCE(r.yield_percent,100)::text END AS "yieldPercent",
 COALESCE(sl.minimum,0)::text AS "minStock",GREATEST(COALESCE(sl.minimum,0),COALESCE(sl.target,0))::text AS "targetStock"
 FROM public.articles a LEFT JOIN public.industrial_article_rules r ON r.article_id=a.id
 LEFT JOIN LATERAL(SELECT sum(s.safety_stock_qty) AS minimum,sum(s.target_stock_qty) AS target,max(s.order_lot_size) AS lot
 FROM public.stock_levels s WHERE s.article_id=a.id) sl ON true
 LEFT JOIN LATERAL(SELECT id FROM public.piece_technique_versions v WHERE v.piece_technique_id=a.piece_technique_id
 AND v.statut='APPLICABLE' AND(v.date_application IS NULL OR v.date_application<=CURRENT_DATE)
 ORDER BY v.date_application DESC NULLS LAST,v.version_interne DESC,v.created_at DESC,v.id LIMIT 1)v ON true
 WHERE a.id=ANY($1::uuid[]) ORDER BY a.id`;

async function catalog(db: Db, seed: string[]) {
  const articles = new Map<string, ArticleRow>(),
    bom: IndustrialBom[] = [],
    issues = new Set<string>();
  let batch = seed;
  for (let depth = 0; batch.length; depth++) {
    if (depth > 32 || articles.size + batch.length > 500) throw tooLarge();
    const rows = (await db.query<ArticleRow>(catalogSql, [batch])).rows;
    for (const r of rows) {
      r.technicalIssues = [];
      if (!r.unit)
        throw new HttpError(
          422,
          "UNIT_REQUIRED",
          "Unité de stock manquante pour " + r.code + ".",
        );
      if (r.kind === "MAKE" && !r.version)
        r.technicalIssues.push("Version applicable manquante.");
      articles.set(r.id, r);
    }
    const versions = rows.flatMap((r) => (r.version ? [r.version] : []));
    const links = (
      await db.query<{
        version: string;
        child: string | null;
        factor: string;
        definition: string;
        child_version: string | null;
      }>(
        `
    SELECT b.parent_piece_technique_version_id::text AS version,COALESCE(b.child_article_id,child.id)::text AS child,
      b.quantite::text AS factor,b.id::text AS definition,b.child_piece_technique_version_id::text AS child_version
    FROM public.pieces_techniques_nomenclature b LEFT JOIN LATERAL(
     SELECT (array_agg(a.id ORDER BY a.id))[1] AS id FROM public.articles a
     WHERE a.piece_technique_id=b.child_piece_technique_id AND a.status='VALIDE' AND a.archived_at IS NULL HAVING count(*)=1) child ON true
    WHERE b.parent_piece_technique_version_id=ANY($1::uuid[]) ORDER BY b.id`,
        [versions],
      )
    ).rows;
    const purchases = (
      await db.query<{
        version: string;
        child: string | null;
        factor: string | null;
        definition: string;
        type: string;
      }>(
        `
    SELECT p.piece_technique_version_id::text AS version,p.article_id::text AS child,p.id::text AS definition,p.type_achat AS type,
     CASE WHEN p.longueur_mm IS NOT NULL OR p.quantite_brut_mm IS NOT NULL THEN
       CASE WHEN upper(a.unite)='MM' THEN (COALESCE(p.longueur_mm,p.quantite_brut_mm)*COALESCE(NULLIF(p.coefficient_chute,0),1))::text END
     ELSE p.quantite::text END AS factor FROM public.pieces_techniques_achats p LEFT JOIN public.articles a ON a.id=p.article_id
    WHERE p.piece_technique_version_id=ANY($1::uuid[]) ORDER BY p.id`,
        [versions],
      )
    ).rows;
    const children = new Set<string>();
    for (const parent of rows.filter((a) => a.version)) {
      const direct = links.filter((e) => e.version === parent.version);
      for (const edge of [
        ...direct,
        ...purchases.filter((e) => e.version === parent.version),
      ]) {
        if (!edge.child || !(Number(edge.factor) > 0)) {
          const issue =
            "Recette à qualifier : " + parent.code + " / " + edge.definition;
          parent.technicalIssues.push(issue);
          issues.add(issue);
          continue;
        }
        // A component duplicated between the purchasing sheet and BOM cannot be added twice.
        if ("type" in edge && direct.some((b) => b.child === edge.child)) {
          const issue =
            "Composant présent dans la nomenclature et les achats : " +
            parent.code;
          parent.technicalIssues.push(issue);
          issues.add(issue);
          continue;
        }
        bom.push({
          parent: parent.id,
          child: edge.child,
          factor: edge.factor!,
        });
        children.add(edge.child);
      }
    }
    batch = [...children].filter((id) => !articles.has(id)).sort();
  }
  return { articles: [...articles.values()], bom, issues };
}
export async function readIndustrialRules(db: Db, articleIds: string[]) {
  return (
    await db.query<IndustrialContractRule>(
      `SELECT l.id::text,c.client_id AS "clientId",a.id::text AS article,
 COALESCE(r.min_stock,0)::text AS reserve,COALESCE(r.max_stock,0)::text AS target,
 COALESCE(r.committed_forecast,false) AS "forecastCommitted",r.risk_limit_eur::text AS "riskEur",COALESCE(r.use_history,false) AS "useHistory"
 FROM public.client_contract_lines l JOIN public.client_contracts c ON c.id=l.contract_id
 JOIN LATERAL (SELECT candidate.id FROM public.articles candidate JOIN public.units unit ON unit.id=l.unit_id AND upper(unit.code)=upper(candidate.unite)
  WHERE COALESCE(candidate.root_article_id,candidate.id)=l.root_article_id AND candidate.archived_at IS NULL AND candidate.status='VALIDE'
   AND EXISTS(SELECT 1 FROM public.article_client_links x WHERE x.article_id=candidate.id AND x.client_id=c.client_id)
   ORDER BY candidate.version_number DESC,candidate.id LIMIT 1) a ON true
 LEFT JOIN public.industrial_contract_rules r ON r.contract_line_id=l.id
 WHERE c.status='ACTIVE' AND l.active AND a.id=ANY($1::uuid[]) ORDER BY l.id,a.id`,
      [articleIds],
    )
  ).rows;
}
export async function readIndustrialInput(
  db: Db,
  clientId: string,
  start: string,
  months = 18,
  weeks = 26,
): Promise<IndustrialInput> {
  const policy = await readIndustrialPolicy(db, clientId);
  const clock = (
    await db.query<{ now: string; today: string; end: string }>(
      `SELECT now()::text AS now,to_char(now() AT TIME ZONE 'Europe/Paris','YYYY-MM-DD') AS today,
 (date_trunc('month',$1::date)+$2::int*interval '1 month'-interval '1 day')::date::text AS "end"`,
      [start, months],
    )
  ).rows[0];
  const seeds = (
    await db.query<{ id: string }>(
      `SELECT id::text FROM (
  SELECT article_id AS id FROM public.article_client_links WHERE client_id=$1
  UNION SELECT l.article_id FROM public.commande_ligne l JOIN public.commande_client c ON c.id=l.commande_id WHERE c.client_id=$1 AND l.article_id IS NOT NULL
  UNION SELECT l.article_id FROM public.client_contract_lines l JOIN public.client_contracts c ON c.id=l.contract_id WHERE c.client_id=$1 AND c.status='ACTIVE'
 ) scope ORDER BY id LIMIT 501`,
      [clientId],
    )
  ).rows.map((a) => a.id);
  const { articles, bom, issues } = await catalog(db, seeds);
  const ids = articles.map((a) => a.id),
    mapped = articles.map((a) => ({
      article_id: a.id,
      root_article_id: a.root,
    }));
  const coverage = await readContractCoverageDemands(db, mapped, [
    { month: start.slice(0, 7), target_date: start, end_date: clock.end },
  ]);
  const rules = await readIndustrialRules(db, ids);
  const firmIds = coverage.firm.map((f) => f.id);
  const firmLines = (
    await db.query<{ id: string; price: string | null; updated_at: string }>(
      `SELECT l.id::text,c.updated_at::text,CASE WHEN c.currency='EUR' THEN l.prix_unitaire_ht::text END AS price
 FROM public.commande_ligne l JOIN public.commande_client c ON c.id=l.commande_id WHERE l.id=ANY($1::bigint[])`,
      [firmIds],
    )
  ).rows;
  const byLine = new Map(firmLines.map((line) => [line.id, line]));
  const demand: IndustrialDemand[] = coverage.demands.map((d) => ({
    id: d.id,
    article: d.article_id,
    unit: d.unit,
    contractLine: d.contract_line_id,
    orderLine: d.order_line_id,
    allocation: d.allocation_id,
    kind: d.kind,
    quantity: d.quantity,
    due: d.due_date,
    priceEur: byLine.get(d.order_line_id ?? "")?.price ?? null,
    orderUpdatedAt: byLine.get(d.order_line_id ?? "")?.updated_at,
  }));
  const internal = (
    await db.query<{
      id: string;
      article: string;
      unit: string;
      due: string | null;
      quantity: string;
    }>(
      `SELECT l.id::text,l.article_id::text AS article,
 upper(btrim(COALESCE(l.unite,a.unite))) AS unit,COALESCE(l.delai_interne,l.delai_client)::date::text AS due,
 GREATEST(l.quantite-COALESCE((SELECT sum(CASE WHEN o.statut::text IN('TERMINE','CLOTURE') THEN
    GREATEST(o.quantite_bonne,COALESCE((SELECT sum(output.qty_ok) FROM public.of_output_lots output WHERE output.of_id=o.id),0))
  WHEN execution.semantics->>'coverage_semantics'='GOOD_OUTPUT_V1' THEN
    GREATEST(LEAST(
      CASE WHEN COALESCE(execution.semantics->>'launched_quantity','')~'^[0-9]+(\\.[0-9]+)?$'
          AND COALESCE(execution.semantics->>'yield_percent','')~'^[0-9]+(\\.[0-9]+)?$'
          AND (execution.semantics->>'yield_percent')::numeric>0
          AND (execution.semantics->>'yield_percent')::numeric<=100
          AND o.quantite_lancee<>(execution.semantics->>'launched_quantity')::numeric
        THEN CASE WHEN lower(btrim(a.unite)) IN('u','pc','pce','pces','pcs','piece','pieces','pièce','pièces','unit','units','unite','unites','unité','unités')
          THEN floor(o.quantite_lancee*(execution.semantics->>'yield_percent')::numeric/100)
          ELSE floor(o.quantite_lancee*(execution.semantics->>'yield_percent')::numeric*1000/100)/1000 END
      WHEN COALESCE(execution.semantics->>'expected_good_quantity','')~'^[0-9]+(\\.[0-9]+)?$'
        THEN (execution.semantics->>'expected_good_quantity')::numeric ELSE 0 END,
      GREATEST(o.quantite_lancee-o.quantite_rebut,0)
    ),0)
  ELSE GREATEST(o.quantite_lancee-o.quantite_rebut,0) END)
  FROM public.ordres_fabrication o LEFT JOIN LATERAL(
    SELECT execution.result->'industrial_proposal' AS semantics FROM public.industrial_proposal_executions execution
    WHERE execution.target_type='OF' AND execution.target_id=o.id::text AND execution.status='EXECUTED' AND execution.action='MAKE'
    ORDER BY execution.created_at DESC,execution.id DESC LIMIT 1
  ) execution ON true
  WHERE o.commande_ligne_id=l.id AND o.parent_of_id IS NULL AND o.statut::text<>'ANNULE'),0),0)::text AS quantity
 FROM public.commande_ligne l JOIN public.commande_client c ON c.id=l.commande_id JOIN public.articles a ON a.id=l.article_id
 WHERE l.article_id=ANY($1::uuid[]) AND c.order_type='INTERNE' AND COALESCE(c.internal_order_purpose,'STANDARD')='STANDARD'
 AND c.statut::text NOT IN('ANNULE','ARCHIVE') ORDER BY l.id LIMIT 2001`,
      [ids],
    )
  ).rows;
  if (internal.length > 2000) throw tooLarge();
  for (const n of internal.filter((n) => Number(n.quantity) > 0)) {
    if (!n.due) {
      issues.add("Commande interne sans échéance : " + n.id);
      continue;
    }
    demand.push({
      id: "internal:" + n.id,
      article: n.article,
      unit: n.unit,
      contractLine: null,
      orderLine: n.id,
      allocation: null,
      kind: "INTERNAL",
      quantity: n.quantity,
      due: n.due,
      priceEur: null,
      buildForStock: true,
    });
  }
  const stock = await readContractCoverageStock(db, ids);
  const production = await readContractCoverageProduction(db, {
    articleIds: ids,
    now: new Date(clock.now).toISOString(),
    endDate: clock.end,
  });
  for (const i of [...stock.issues, ...production.issues])
    issues.add(i.message);
  const owned = new Set(
    (
      await db.query<{ id: string }>(
        "SELECT id::text FROM public.lots WHERE article_id::text=ANY($1::text[]) AND client_proprietaire_id IS NOT NULL",
        [ids],
      )
    ).rows.map((r) => r.id),
  );
  const supplies: IndustrialSource[] = [...stock.sources, ...production.sources]
    .filter((s) => s.kind !== "FREE" || !owned.has(s.reference_id))
    .map((s) => ({
      id: s.id,
      article: s.article_id,
      unit: s.unit,
      quantity: s.quantity,
      available: s.available_date ?? clock.today,
      orderLine: s.order_line_id,
      allocation: s.allocation_id,
      contractLine: null,
      kind: s.kind === "PRODUCTION" ? "OF" : "STOCK",
    }));
  const internalLineIds = new Set(internal.map((row) => row.id));
  for (const s of supplies)
    if (s.kind === "OF" && s.orderLine && internalLineIds.has(s.orderLine))
      s.orderLine = null;
  const rooted = (
    await db.query<{ id: string; contract_line_id: string }>(
      `SELECT r.root_of_id::text AS id,p.contract_line_id::text
 FROM public.client_contract_replenishment_roots r JOIN public.client_contract_replenishment_proposals p ON p.id=r.proposal_id
 WHERE r.article_id=ANY($1::uuid[]) ORDER BY r.root_of_id`,
      [ids],
    )
  ).rows;
  const rootedOwner = new Map(rooted.map((r) => [r.id, r.contract_line_id]));
  for (const s of supplies)
    if (s.kind === "OF")
      s.contractLine = rootedOwner.get(s.id.split(":")[1]) ?? null;
  const purchases = await readFutureMaterialSupplyTx(db, ids, true);
  for (const po of purchases) {
    if (
      !["ACCUSE_RECU", "PARTIELLEMENT_RECUE"].includes(po.status) ||
      !po.due ||
      po.due < clock.today ||
      po.ownerClientId ||
      !po.unit ||
      po.available <= 0 ||
      (po.unit !== po.purchaseUnit && po.coefficient === 1) ||
      po.documents.length ||
      po.requirements.some((r) => r.obligatoire)
    ) {
      issues.add(
        "Achat " + po.code + " : réception libre non confirmée ou à qualifier.",
      );
      continue;
    }
    supplies.push({
      id: "oa:" + po.id,
      article: po.articleId,
      unit: po.unit.toUpperCase(),
      quantity: String(po.available),
      available: po.due,
      kind: "OA",
      orderLine: null,
      allocation: null,
      contractLine: null,
    });
  }
  const days = (
    await db.query<{ day: string }>(
      `SELECT to_char(d,'YYYY-MM-DD') AS day FROM public.planning_central_settings s
 JOIN public.programmation_calendars c ON c.id=s.workshop_calendar_id AND c.active
 CROSS JOIN generate_series($1::date-740,$2::date,'1 day'::interval) AS d
 WHERE s.singleton AND extract(isodow FROM d)::smallint=ANY(c.working_days)
 AND NOT EXISTS(SELECT 1 FROM public.programmation_calendar_closures x WHERE x.calendar_id=c.id AND d::date BETWEEN x.start_date AND x.end_date) ORDER BY d`,
      [start, clock.end],
    )
  ).rows;
  if (!days.length)
    issues.add("Calendrier atelier absent : dates de lancement à qualifier.");
  const exposure = (
    await db.query<{ value: string | null }>(industrialExposureSql, [ids])
  ).rows[0].value;
  if (exposure === null)
    issues.add(
      "Exposition existante non valorisée : les prévisions libres ne peuvent engager de dépense.",
    );
  const retained = await consumeGrossForecasts(
    db,
    await expandPilotForecasts(db, demand, issues),
    issues,
  );
  retained.push(
    ...(await historySuggestions(db, {
      client: clientId,
      start,
      end: clock.end,
      today: clock.today,
      rules,
      demand: retained,
    })),
  );
  return {
    start,
    today: clock.today,
    months,
    weeks,
    frozenDays: 14,
    clientId,
    clientRisk:
      policy.risk_limit_eur === null ? null : String(policy.risk_limit_eur),
    openingExposure: exposure,
    articles,
    bom,
    demand: retained,
    supplies,
    rules,
    workdays: days.map((d) => d.day),
    issues: [...issues].sort(),
  };
}
// Conservative upper bound across the selected references. Stock, unreceived output and
// outstanding purchases are disjoint quantities. Unknown value disables forecast spending.
const industrialExposureSql = `WITH physical AS (
 SELECT s.article_id,GREATEST(s.qty_total,0) AS qty,r.unit_cost_eur AS price FROM public.stock_levels s
 LEFT JOIN public.industrial_article_rules r ON r.article_id=s.article_id WHERE s.article_id=ANY($1::uuid[])
), wip AS (
 SELECT o.article_id,GREATEST(o.quantite_lancee-o.quantite_rebut-COALESCE((SELECT sum(out.qty_ok) FROM public.of_output_lots out WHERE out.of_id=o.id),0),0) AS qty,r.unit_cost_eur AS price
 FROM public.ordres_fabrication o LEFT JOIN public.industrial_article_rules r ON r.article_id=o.article_id
 WHERE o.article_id=ANY($1::uuid[]) AND o.statut::text IN ('PLANIFIE','EN_COURS','EN_PAUSE')
), orders AS (
 SELECT l.article_id,GREATEST(l.quantite-l.qty_annulee-COALESCE((SELECT sum(x.qty_received) FROM public.reception_fournisseur_lignes x
 JOIN public.receptions_fournisseurs h ON h.id=x.reception_id WHERE h.status<>'CANCELLED' AND x.commande_fournisseur_ligne_id=l.id),0),0) AS qty,
 CASE WHEN c.devise='EUR' THEN NULLIF(l.prix_unitaire_ht,0) END AS price
 FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur c ON c.id=l.commande_id
 WHERE l.article_id=ANY($1::uuid[]) AND l.statut_ligne='ACTIVE' AND c.statut IN('ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE')
), exposure AS (SELECT * FROM physical UNION ALL SELECT * FROM wip UNION ALL SELECT * FROM orders)
 SELECT CASE WHEN count(*) FILTER(WHERE qty>0 AND price IS NULL)>0 THEN NULL ELSE COALESCE(sum(qty*price),0)::text END AS value FROM exposure`;
