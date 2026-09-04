import crypto from "node:crypto";

import {
  loadApplicableTechnicalSnapshot,
  loadFabricationGenerationTree,
  type Queryable,
} from "../../production/domain/of-generation";

export type ManufacturingMode = "SIMPLE" | "ASSEMBLY";
export type AssemblySupplyStrategy = "MAKE_TO_ORDER" | "INTERNAL_CONTRACT";
export type AssemblyComponentAction = "RESERVE" | "CREATE_CHILD_OF" | "PURCHASE" | "WAIT_TECHNICAL";

export type AssemblyContractAllocationPlan = {
  of_id: number;
  of_numero: string;
  available_date: string | null;
  quantity: number;
};

export type AssemblyComponentPlan = {
  structure_path: string;
  parent_structure_path: string;
  depth: number;
  kind: "FABRICATED" | "PURCHASED";
  source_line_id: string | null;
  parent_piece_technique_id: string;
  parent_piece_technique_version_id: string;
  article_id: string | null;
  article_code: string | null;
  designation: string;
  piece_technique_id: string | null;
  piece_technique_version_id: string | null;
  quantity_per_parent: number;
  required_qty: number;
  old_available_qty: number;
  old_used_qty: number;
  new_available_qty: number;
  new_used_qty: number;
  shortage_qty: number;
  action: AssemblyComponentAction;
};

export type AssemblyPlan = {
  manufacturing_mode: ManufacturingMode;
  assembly_supply_strategy: AssemblySupplyStrategy;
  technical_status: "READY" | "WAITING_TECHNICAL";
  assembly_qty: number;
  contract_covered_qty: number;
  quantity_to_assemble: number;
  contract_allocations: AssemblyContractAllocationPlan[];
  components: AssemblyComponentPlan[];
  planned_of_quantities_by_path: Record<string, number>;
  warnings: string[];
  supply_plan_hash: string;
};

type Availability = { OLD: number; NEW: number };

export type AssemblyPlanningLedger = {
  availabilityByKey: Map<string, Availability>;
  contractCapacityByOf: Map<number, number>;
};

export function createAssemblyPlanningLedger(): AssemblyPlanningLedger {
  return { availabilityByKey: new Map(), contractCapacityByOf: new Map() };
}

function normalized(value: number): number {
  return Number(Math.max(0, value).toFixed(6));
}

function stockKey(articleId: string, versionId: string | null): string {
  return versionId ? `${articleId}:${versionId}` : articleId;
}

function takeAvailability(availability: Availability, requiredQty: number) {
  const required = normalized(requiredQty);
  const oldAvailable = normalized(availability.OLD);
  const oldUsed = normalized(Math.min(required, oldAvailable));
  const afterOld = normalized(required - oldUsed);
  const newAvailable = normalized(availability.NEW);
  const newUsed = normalized(Math.min(afterOld, newAvailable));
  const shortage = normalized(afterOld - newUsed);
  availability.OLD = normalized(oldAvailable - oldUsed);
  availability.NEW = normalized(newAvailable - newUsed);
  return {
    old_available_qty: oldAvailable,
    old_used_qty: oldUsed,
    new_available_qty: newAvailable,
    new_used_qty: newUsed,
    shortage_qty: shortage,
  };
}

async function ensureAvailability(
  tx: Queryable,
  ledger: AssemblyPlanningLedger,
  requirements: Array<{ article_id: string; piece_technique_version_id: string | null }>
) {
  const missing = requirements.filter(
    (requirement) => !ledger.availabilityByKey.has(stockKey(requirement.article_id, requirement.piece_technique_version_id))
  );
  if (missing.length === 0) return;
  const articleIds = Array.from(new Set(missing.map((requirement) => requirement.article_id)));
  const rows = await tx.query<{
    article_id: string;
    piece_technique_version_id: string | null;
    stock_scope: "OLD" | "NEW";
    qty_available: number;
  }>(
    `SELECT availability.article_id::text AS article_id,
            lot.piece_technique_version_id::text AS piece_technique_version_id,
            CASE WHEN lot.origin_stock_scope = 'OLD' THEN 'OLD'
                 ELSE COALESCE(lot.source_scope, lot.stock_scope, warehouse.stock_scope, 'NEW') END AS stock_scope,
            COALESCE(sum(availability.qty_available), 0)::float8 AS qty_available
       FROM public.v_stock_availability_225 availability
       JOIN public.warehouses warehouse ON warehouse.id = availability.warehouse_id
       JOIN public.lots lot ON lot.id = availability.lot_id
      WHERE availability.article_id = ANY($1::uuid[])
        AND availability.managed_in_stock = true
        AND availability.qty_available > 0
        AND COALESCE(lot.lot_status, 'LIBERE') = 'LIBERE'
        AND CASE WHEN lot.origin_stock_scope = 'OLD' THEN 'OLD'
                 ELSE COALESCE(lot.source_scope, lot.stock_scope, warehouse.stock_scope, 'NEW') END IN ('OLD', 'NEW')
      GROUP BY availability.article_id, lot.piece_technique_version_id,
               CASE WHEN lot.origin_stock_scope = 'OLD' THEN 'OLD'
                    ELSE COALESCE(lot.source_scope, lot.stock_scope, warehouse.stock_scope, 'NEW') END`,
    [articleIds]
  );

  for (const requirement of missing) {
    ledger.availabilityByKey.set(stockKey(requirement.article_id, requirement.piece_technique_version_id), { OLD: 0, NEW: 0 });
  }
  for (const row of rows.rows) {
    const exactKey = stockKey(row.article_id, row.piece_technique_version_id);
    const unversionedKey = stockKey(row.article_id, null);
    const targetKeys = Array.from(new Set([exactKey, unversionedKey]));
    for (const key of targetKeys) {
      const availability = ledger.availabilityByKey.get(key);
      if (availability) availability[row.stock_scope] = normalized(availability[row.stock_scope] + Number(row.qty_available));
    }
  }
}

async function resolveArticleByPiece(tx: Queryable, pieceIds: string[]): Promise<Map<string, { article_id: string; article_code: string | null; designation: string }>> {
  if (pieceIds.length === 0) return new Map();
  const rows = await tx.query<{ piece_technique_id: string; article_id: string; article_code: string | null; designation: string }>(
    `SELECT article.piece_technique_id::text AS piece_technique_id,
            article.id::text AS article_id,
            article.code AS article_code,
            article.designation
       FROM public.articles article
      WHERE article.piece_technique_id = ANY($1::uuid[])
        AND article.is_active = true
      ORDER BY article.piece_technique_id, article.created_at, article.id`,
    [pieceIds]
  );
  const byPiece = new Map<string, { article_id: string; article_code: string | null; designation: string }>();
  for (const row of rows.rows) if (!byPiece.has(row.piece_technique_id)) byPiece.set(row.piece_technique_id, row);
  return byPiece;
}

async function loadPurchasedRequirements(
  tx: Queryable,
  parents: Array<{ structure_path: string; piece_technique_id: string; piece_technique_version_id: string; production_qty: number; depth: number }>
) {
  if (parents.length === 0) return [];
  const parentPieceIds = Array.from(new Set(parents.map((parent) => parent.piece_technique_id)));
  const rows = await tx.query<{
    source_line_id: string;
    piece_technique_id: string;
    parent_piece_technique_version_id: string | null;
    article_id: string;
    article_code: string | null;
    designation: string;
    quantity_per_parent: number;
    source_kind: "BOM" | "PURCHASE";
  }>(
    `SELECT line.id::text AS source_line_id,
            line.parent_piece_technique_id::text AS piece_technique_id,
            line.parent_piece_technique_version_id::text AS parent_piece_technique_version_id,
            article.id::text AS article_id,
            article.code AS article_code,
            COALESCE(line.designation, article.designation) AS designation,
            line.quantite::float8 AS quantity_per_parent,
            'BOM'::text AS source_kind
       FROM public.pieces_techniques_nomenclature line
       JOIN public.articles article ON article.id = line.child_article_id
      WHERE line.parent_piece_technique_id = ANY($1::uuid[])
        AND line.child_article_id IS NOT NULL
      UNION ALL
     SELECT purchase.id::text AS source_line_id,
            purchase.piece_technique_id::text AS piece_technique_id,
            NULL::text AS parent_piece_technique_version_id,
            article.id::text AS article_id,
            article.code AS article_code,
            COALESCE(purchase.nom, article.designation) AS designation,
            purchase.quantite::float8 AS quantity_per_parent,
            'PURCHASE'::text AS source_kind
       FROM public.pieces_techniques_achats purchase
       JOIN public.articles article ON article.id = purchase.article_id
      WHERE purchase.piece_technique_id = ANY($1::uuid[])
        AND purchase.article_id IS NOT NULL`,
    [parentPieceIds]
  );
  return parents.flatMap((parent) => rows.rows
    .filter((row) => row.piece_technique_id === parent.piece_technique_id
      && (row.parent_piece_technique_version_id === null
        || row.parent_piece_technique_version_id === parent.piece_technique_version_id))
    .map((row) => ({ ...row, parent, required_qty: normalized(parent.production_qty * Number(row.quantity_per_parent)) }))
    .filter((row) => row.required_qty > 0));
}

async function planInternalContractCoverage(
  tx: Queryable,
  ledger: AssemblyPlanningLedger,
  params: { article_id: string; version_id: string; required_qty: number; due_date: string | null }
): Promise<AssemblyContractAllocationPlan[]> {
  if (params.required_qty <= 0) return [];
  const rows = await tx.query<{
    of_id: number;
    of_numero: string;
    available_date: string | null;
    remaining_qty: number;
  }>(
    `SELECT fabrication.id::bigint::int AS of_id,
            fabrication.numero AS of_numero,
            COALESCE(fabrication.date_fin_prevue::text, commande.date_commande::text) AS available_date,
            GREATEST(0, fabrication.quantite_lancee
              - COALESCE(sum(allocation.quantity) FILTER (WHERE allocation.status <> 'CANCELLED'), 0))::float8 AS remaining_qty
       FROM public.ordres_fabrication fabrication
       JOIN public.commande_client commande ON commande.id = fabrication.commande_id
       LEFT JOIN public.internal_contract_of_allocations allocation ON allocation.of_id = fabrication.id
      WHERE commande.order_type = 'INTERNE'
        AND commande.internal_order_purpose = 'CONTRACT'
        AND fabrication.article_id = $1::uuid
        AND fabrication.piece_technique_version_id = $2::uuid
        AND fabrication.statut::text NOT IN ('ANNULE', 'TERMINE')
        AND ($3::date IS NULL OR COALESCE(fabrication.date_fin_prevue, commande.date_commande) <= $3::date)
      GROUP BY fabrication.id, fabrication.numero, fabrication.date_fin_prevue, commande.date_commande, fabrication.quantite_lancee
     HAVING GREATEST(0, fabrication.quantite_lancee
              - COALESCE(sum(allocation.quantity) FILTER (WHERE allocation.status <> 'CANCELLED'), 0)) > 0
      ORDER BY COALESCE(fabrication.date_fin_prevue, commande.date_commande), fabrication.numero`,
    [params.article_id, params.version_id, params.due_date]
  );
  let remaining = normalized(params.required_qty);
  const allocations: AssemblyContractAllocationPlan[] = [];
  for (const row of rows.rows) {
    if (remaining <= 0) break;
    if (!ledger.contractCapacityByOf.has(row.of_id)) {
      ledger.contractCapacityByOf.set(row.of_id, normalized(Number(row.remaining_qty)));
    }
    const capacity = ledger.contractCapacityByOf.get(row.of_id) ?? 0;
    const quantity = normalized(Math.min(remaining, capacity));
    if (quantity <= 0) continue;
    allocations.push({ of_id: row.of_id, of_numero: row.of_numero, available_date: row.available_date, quantity });
    ledger.contractCapacityByOf.set(row.of_id, normalized(capacity - quantity));
    remaining = normalized(remaining - quantity);
  }
  return allocations;
}

export async function planAssemblyRequirements(
  tx: Queryable,
  params: {
    root_article_id: string;
    root_piece_technique_id: string;
    root_piece_technique_version_id: string | null;
    quantity: number;
    due_date: string | null;
    ledger?: AssemblyPlanningLedger;
  }
): Promise<AssemblyPlan> {
  const ledger = params.ledger ?? createAssemblyPlanningLedger();
  const requested = normalized(params.quantity);
  const version = params.root_piece_technique_version_id
    ? await tx.query<{
        id: string;
        statut: string;
        effective: boolean;
        manufacturing_mode: ManufacturingMode;
        assembly_supply_strategy: AssemblySupplyStrategy;
      }>(
        `SELECT id::text AS id, statut,
                (statut = 'APPLICABLE' AND (date_effet IS NULL OR date_effet <= CURRENT_DATE)) AS effective,
                manufacturing_mode, assembly_supply_strategy
           FROM public.piece_technique_versions
          WHERE id = $1::uuid AND piece_technique_id = $2::uuid`,
        [params.root_piece_technique_version_id, params.root_piece_technique_id]
      )
    : null;
  const selected = version?.rows[0] ?? null;
  const manufacturingMode = selected?.manufacturing_mode ?? "SIMPLE";
  const supplyStrategy = selected?.assembly_supply_strategy ?? "MAKE_TO_ORDER";

  const base = {
    manufacturing_mode: manufacturingMode,
    assembly_supply_strategy: supplyStrategy,
    assembly_qty: requested,
    contract_covered_qty: 0,
    quantity_to_assemble: requested,
    contract_allocations: [] as AssemblyContractAllocationPlan[],
    components: [] as AssemblyComponentPlan[],
    planned_of_quantities_by_path: {} as Record<string, number>,
    warnings: [] as string[],
  };
  if (!selected?.effective) {
    const value = { ...base, technical_status: "WAITING_TECHNICAL" as const, warnings: ["ASSEMBLY_TECHNICAL_REVISION_NOT_APPLICABLE"] };
    return { ...value, supply_plan_hash: crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex") };
  }
  if (manufacturingMode === "SIMPLE") {
    const value = { ...base, technical_status: "READY" as const };
    return { ...value, supply_plan_hash: crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex") };
  }

  const contractAllocations = supplyStrategy === "INTERNAL_CONTRACT"
    ? await planInternalContractCoverage(tx, ledger, {
        article_id: params.root_article_id,
        version_id: selected.id,
        required_qty: requested,
        due_date: params.due_date,
      })
    : [];
  const contractCoveredQty = normalized(contractAllocations.reduce((sum, allocation) => sum + allocation.quantity, 0));
  const quantityToAssemble = normalized(requested - contractCoveredQty);
  const tree = await loadFabricationGenerationTree(tx, params.root_piece_technique_id);
  const articlesByPiece = await resolveArticleByPiece(tx, tree.map((node) => node.piece_technique_id));
  const productionByPath = new Map<string, number>();
  const versionByPath = new Map<string, string>();
  const rootPath = tree[0]?.key ?? params.root_piece_technique_id;
  productionByPath.set(rootPath, quantityToAssemble);
  versionByPath.set(rootPath, selected.id);
  const components: AssemblyComponentPlan[] = [];
  const plannedOfQuantitiesByPath: Record<string, number> = quantityToAssemble > 0 ? { [rootPath]: quantityToAssemble } : {};

  for (const node of tree.slice(1)) {
    const parentPath = node.parent_key;
    if (!parentPath) continue;
    const parentProduction = productionByPath.get(parentPath) ?? 0;
    const requiredQty = normalized(parentProduction * node.quantite_par_parent);
    if (requiredQty <= 0) {
      productionByPath.set(node.key, 0);
      continue;
    }
    const article = articlesByPiece.get(node.piece_technique_id);
    if (!article) {
      components.push({
        structure_path: node.key,
        parent_structure_path: parentPath,
        depth: node.level,
        kind: "FABRICATED",
        source_line_id: node.bom_line_id,
        parent_piece_technique_id: node.parent_piece_technique_id ?? params.root_piece_technique_id,
        parent_piece_technique_version_id: versionByPath.get(parentPath) ?? selected.id,
        article_id: null,
        article_code: null,
        designation: node.designation,
        piece_technique_id: node.piece_technique_id,
        piece_technique_version_id: null,
        quantity_per_parent: node.quantite_par_parent,
        required_qty: requiredQty,
        old_available_qty: 0,
        old_used_qty: 0,
        new_available_qty: 0,
        new_used_qty: 0,
        shortage_qty: requiredQty,
        action: "WAIT_TECHNICAL",
      });
      productionByPath.set(node.key, 0);
      continue;
    }
    let technical;
    try {
      technical = await loadApplicableTechnicalSnapshot(tx, node.piece_technique_id);
    } catch {
      technical = null;
    }
    if (!technical) {
      components.push({
        structure_path: node.key,
        parent_structure_path: parentPath,
        depth: node.level,
        kind: "FABRICATED",
        source_line_id: node.bom_line_id,
        parent_piece_technique_id: node.parent_piece_technique_id ?? params.root_piece_technique_id,
        parent_piece_technique_version_id: versionByPath.get(parentPath) ?? selected.id,
        article_id: article.article_id,
        article_code: article.article_code,
        designation: article.designation,
        piece_technique_id: node.piece_technique_id,
        piece_technique_version_id: null,
        quantity_per_parent: node.quantite_par_parent,
        required_qty: requiredQty,
        old_available_qty: 0,
        old_used_qty: 0,
        new_available_qty: 0,
        new_used_qty: 0,
        shortage_qty: requiredQty,
        action: "WAIT_TECHNICAL",
      });
      productionByPath.set(node.key, 0);
      continue;
    }
    versionByPath.set(node.key, technical.version_id);
    await ensureAvailability(tx, ledger, [{ article_id: article.article_id, piece_technique_version_id: technical.version_id }]);
    const allocation = takeAvailability(
      ledger.availabilityByKey.get(stockKey(article.article_id, technical.version_id)) ?? { OLD: 0, NEW: 0 },
      requiredQty
    );
    const action: AssemblyComponentAction = allocation.shortage_qty > 0 ? "CREATE_CHILD_OF" : "RESERVE";
    components.push({
      structure_path: node.key,
      parent_structure_path: parentPath,
      depth: node.level,
      kind: "FABRICATED",
      source_line_id: node.bom_line_id,
      parent_piece_technique_id: node.parent_piece_technique_id ?? params.root_piece_technique_id,
      parent_piece_technique_version_id: versionByPath.get(parentPath) ?? selected.id,
      article_id: article.article_id,
      article_code: article.article_code,
      designation: article.designation,
      piece_technique_id: node.piece_technique_id,
      piece_technique_version_id: technical.version_id,
      quantity_per_parent: node.quantite_par_parent,
      required_qty: requiredQty,
      ...allocation,
      action,
    });
    productionByPath.set(node.key, allocation.shortage_qty);
    if (allocation.shortage_qty > 0) plannedOfQuantitiesByPath[node.key] = allocation.shortage_qty;
  }

  const activeParents = tree
    .map((node) => ({
      structure_path: node.key,
      piece_technique_id: node.piece_technique_id,
      piece_technique_version_id: versionByPath.get(node.key) ?? selected.id,
      production_qty: productionByPath.get(node.key) ?? 0,
      depth: node.level,
    }))
    .filter((parent) => parent.production_qty > 0);
  const purchased = await loadPurchasedRequirements(tx, activeParents);
  await ensureAvailability(tx, ledger, purchased.map((row) => ({ article_id: row.article_id, piece_technique_version_id: null })));
  for (const row of purchased) {
    const allocation = takeAvailability(
      ledger.availabilityByKey.get(stockKey(row.article_id, null)) ?? { OLD: 0, NEW: 0 },
      row.required_qty
    );
    components.push({
      structure_path: `${row.parent.structure_path}/purchase:${row.source_line_id}`,
      parent_structure_path: row.parent.structure_path,
      depth: row.parent.depth + 1,
      kind: "PURCHASED",
      source_line_id: row.source_line_id,
      parent_piece_technique_id: row.parent.piece_technique_id,
      parent_piece_technique_version_id: row.parent.piece_technique_version_id,
      article_id: row.article_id,
      article_code: row.article_code,
      designation: row.designation,
      piece_technique_id: null,
      piece_technique_version_id: null,
      quantity_per_parent: Number(row.quantity_per_parent),
      required_qty: row.required_qty,
      ...allocation,
      action: allocation.shortage_qty > 0 ? "PURCHASE" : "RESERVE",
    });
  }

  const warnings = [
    ...(quantityToAssemble > 0 && tree.length <= 1 && purchased.length === 0 ? ["ASSEMBLY_COMPOSITION_EMPTY"] : []),
    ...(components.some((component) => component.action === "WAIT_TECHNICAL") ? ["ASSEMBLY_COMPONENT_TECHNICAL_DATA_MISSING"] : []),
    ...(supplyStrategy === "INTERNAL_CONTRACT" && quantityToAssemble > 0 ? ["INTERNAL_CONTRACT_REMAINDER_REQUIRED"] : []),
  ];
  const value = {
    manufacturing_mode: manufacturingMode,
    assembly_supply_strategy: supplyStrategy,
    technical_status: "READY" as const,
    assembly_qty: requested,
    contract_covered_qty: contractCoveredQty,
    quantity_to_assemble: quantityToAssemble,
    contract_allocations: contractAllocations,
    components,
    planned_of_quantities_by_path: plannedOfQuantitiesByPath,
    warnings,
  };
  return { ...value, supply_plan_hash: crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex") };
}

export function computeCommandeSupplyPlanHash(lines: Array<{ commande_ligne_id: number; assembly_plan?: AssemblyPlan | null }>): string {
  const canonical = lines.map((line) => ({
    commande_ligne_id: line.commande_ligne_id,
    supply_plan_hash: line.assembly_plan?.supply_plan_hash ?? null,
  }));
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
