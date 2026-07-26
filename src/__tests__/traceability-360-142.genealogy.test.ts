// #142 — Scénarios de généalogie industrielle réels, joués sur le moteur pur.
//
// Le « monde » ci-dessous est un atelier miniature mais complet : réception
// fournisseur, deux lots matière, un OF enfant qui produit un sous-ensemble,
// un OF parent qui le consomme, une réception de production, un contrôle avec
// instrument, un split de lot, deux BL partiels et un mouvement compensatoire.
//
// Les arêtes respectent la convention du module : `from` est TOUJOURS l'amont
// industriel, `to` l'aval, quel que soit le sens de découverte.

import { describe, expect, it } from "vitest";

import {
  expandGraph,
  type NeighborEdge,
} from "../module/traceability/domain/traceability-graph";
import {
  nodeKey,
  type TraceabilityNodeRef,
  type TraceabilityProofLevel,
  type TraceabilityRelationType,
} from "../module/traceability/domain/traceability-model";

const u = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

const FOURNISSEUR = { type: "fournisseur", id: u(1) } as const;
const RECEPTION = { type: "reception_fournisseur", id: u(2) } as const;
const RECEPTION_LIGNE = { type: "reception_ligne", id: u(3) } as const;
const LOT_MATIERE = { type: "lot", id: u(4) } as const;
const LOT_MATIERE_2 = { type: "lot", id: u(5) } as const;
const LOT_SPLIT = { type: "lot", id: u(6) } as const;
const OF_ENFANT = { type: "of", id: "10" } as const;
const OF_PARENT = { type: "of", id: "11" } as const;
const LOT_SOUS_ENSEMBLE = { type: "lot", id: u(7) } as const;
const LOT_FINI = { type: "lot", id: u(8) } as const;
const OF_RECEIPT = { type: "of_receipt", id: u(9) } as const;
const CONTROLE = { type: "quality_control", id: u(10) } as const;
const MESURE = { type: "quality_measurement", id: u(11) } as const;
const INSTRUMENT = { type: "metrology_equipment", id: u(12) } as const;
const BL_1 = { type: "bon_livraison", id: u(13) } as const;
const BL_2 = { type: "bon_livraison", id: u(14) } as const;
const BL_LIGNE_1 = { type: "bon_livraison_ligne", id: u(15) } as const;
const BL_LIGNE_2 = { type: "bon_livraison_ligne", id: u(16) } as const;
const CLIENT = { type: "client", id: "ACM" } as const;
const MVT_SORTIE = { type: "stock_movement", id: u(17) } as const;
const MVT_COMPENSATION = { type: "stock_movement", id: u(18) } as const;
const NC = { type: "non_conformity", id: u(19) } as const;
const OPERATION = { type: "of_operation", id: u(20) } as const;
const POINTAGE = { type: "pointage", id: u(21) } as const;
const MACHINE = { type: "machine", id: u(22) } as const;
const LOT_ORPHELIN = { type: "lot", id: u(30) } as const;

type Spec = {
  from: TraceabilityNodeRef;
  to: TraceabilityNodeRef;
  relation: TraceabilityRelationType;
  proof?: TraceabilityProofLevel;
  qty?: number;
  unit?: string;
  at?: string;
  evidence?: string;
  lateral?: boolean;
};

/** Le monde : liste d'arêtes en sens de flux (amont → aval). */
const WORLD: Spec[] = [
  { from: FOURNISSEUR, to: RECEPTION, relation: "ORDERED_FROM", at: "2026-01-05" },
  { from: RECEPTION, to: RECEPTION_LIGNE, relation: "RECEPTION_LINE_OF", at: "2026-01-05" },
  { from: RECEPTION_LIGNE, to: LOT_MATIERE, relation: "CREATED_LOT", qty: 120, unit: "kg", at: "2026-01-05" },
  { from: RECEPTION_LIGNE, to: LOT_MATIERE_2, relation: "CREATED_LOT", qty: 80, unit: "kg", at: "2026-01-06" },

  // Fractionnement du lot matière
  { from: LOT_MATIERE, to: LOT_SPLIT, relation: "SPLIT_FROM", qty: 40, unit: "kg", at: "2026-01-10" },

  // Deux lots matière consommés par le MÊME OF enfant
  { from: LOT_MATIERE, to: OF_ENFANT, relation: "CONSUMED_BY", qty: 60, unit: "kg", at: "2026-02-01" },
  { from: LOT_MATIERE_2, to: OF_ENFANT, relation: "CONSUMED_BY", qty: 20, unit: "kg", at: "2026-02-01" },
  // Le MÊME lot matière consommé par un SECOND OF
  { from: LOT_MATIERE, to: OF_PARENT, relation: "CONSUMED_BY", qty: 10, unit: "kg", at: "2026-03-01" },
  // Consommation seulement DÉCLARÉE (référence documentaire, non contrainte)
  {
    from: LOT_SPLIT,
    to: OF_PARENT,
    relation: "CONSUMED_BY",
    proof: "declared",
    qty: 5,
    unit: "kg",
    at: "2026-03-02",
  },

  { from: OF_ENFANT, to: OF_PARENT, relation: "CHILD_OF", at: "2026-02-01" },
  { from: OF_ENFANT, to: LOT_SOUS_ENSEMBLE, relation: "PRODUCED_BY", qty: 25, unit: "U", at: "2026-02-20" },
  // Le sous-ensemble est consommé par l'OF parent
  { from: LOT_SOUS_ENSEMBLE, to: OF_PARENT, relation: "CONSUMED_BY", qty: 25, unit: "U", at: "2026-03-01" },

  { from: OF_PARENT, to: OPERATION, relation: "OF_OPERATION_OF", at: "2026-03-05" },
  { from: OPERATION, to: MACHINE, relation: "EXECUTED_ON", at: "2026-03-05" },
  { from: OPERATION, to: POINTAGE, relation: "CLOCKED_IN", qty: 180, unit: "min", at: "2026-03-05" },

  { from: OF_PARENT, to: OF_RECEIPT, relation: "ISSUED_FROM", qty: 24, unit: "U", at: "2026-03-20" },
  { from: OF_RECEIPT, to: LOT_FINI, relation: "CREATED_LOT", qty: 24, unit: "U", at: "2026-03-20" },
  { from: OF_PARENT, to: LOT_FINI, relation: "PRODUCED_BY", qty: 24, unit: "U", at: "2026-03-20" },

  { from: LOT_FINI, to: CONTROLE, relation: "CONTROLLED_BY", lateral: true, at: "2026-03-21" },
  { from: CONTROLE, to: MESURE, relation: "MEASURED_IN", at: "2026-03-21" },
  { from: MESURE, to: INSTRUMENT, relation: "MEASURED_WITH", at: "2026-03-21" },
  { from: LOT_FINI, to: NC, relation: "AFFECTED_BY_NC", lateral: true, at: "2026-03-22" },

  // Livraison partielle : le lot fini part sur DEUX BL
  { from: LOT_FINI, to: BL_LIGNE_1, relation: "ALLOCATED_TO", qty: 10, unit: "U", at: "2026-04-01" },
  { from: LOT_FINI, to: BL_LIGNE_2, relation: "ALLOCATED_TO", qty: 14, unit: "U", at: "2026-04-15" },
  { from: BL_LIGNE_1, to: BL_1, relation: "DELIVERY_LINE_OF", at: "2026-04-01" },
  { from: BL_LIGNE_2, to: BL_2, relation: "DELIVERY_LINE_OF", at: "2026-04-15" },
  { from: BL_1, to: CLIENT, relation: "DELIVERED_TO", at: "2026-04-02" },
  { from: BL_2, to: CLIENT, relation: "DELIVERED_TO", at: "2026-04-16" },

  // Mouvement de sortie et sa compensation
  { from: LOT_FINI, to: MVT_SORTIE, relation: "MOVED_BY", qty: 24, unit: "U", at: "2026-04-01" },
  { from: MVT_SORTIE, to: MVT_COMPENSATION, relation: "COMPENSATES", at: "2026-04-03" },

  // Lot sans origine prouvée (données CLIPPER incomplètes)
  { from: LOT_ORPHELIN, to: OF_PARENT, relation: "CONSUMED_BY", proof: "unknown", at: "2026-03-01" },
];

function toEdge(spec: Spec, direction: "upstream" | "downstream"): NeighborEdge {
  return {
    direction: spec.lateral ? "lateral" : direction,
    relation: spec.relation,
    from: spec.from,
    to: spec.to,
    proof_level: spec.proof ?? "proven",
    proof_source: "test-world",
    effective_at: spec.at ? `${spec.at}T00:00:00.000Z` : null,
    qty: spec.qty ?? null,
    unit: spec.unit ?? null,
    correlation_id: null,
    evidence_ref: spec.evidence ?? `${nodeKey(spec.from)}->${nodeKey(spec.to)}#${spec.relation}`,
    historical_status: null,
    meta: null,
  };
}

/**
 * Repository simulé, avec la MÊME convention que le vrai : en amont on filtre
 * sur `to`, en aval sur `from`. Les arêtes latérales sont émises une seule
 * fois, comme côté SQL.
 */
async function fetchNeighbors(
  refs: TraceabilityNodeRef[],
  direction: "upstream" | "downstream"
): Promise<NeighborEdge[]> {
  const keys = new Set(refs.map(nodeKey));
  const out: NeighborEdge[] = [];
  for (const spec of WORLD) {
    if (spec.lateral) {
      // Une preuve attachée est découverte « latéralement » depuis son objet,
      // et « en amont » quand on part de la preuve pour retrouver l'objet —
      // exactement ce que font `expandLot` (latéral) et `expandNonConformity`
      // (amont) côté SQL.
      if (direction === "downstream" && keys.has(nodeKey(spec.from))) {
        out.push(toEdge(spec, direction));
      }
      if (direction === "upstream" && keys.has(nodeKey(spec.to))) {
        out.push({ ...toEdge(spec, direction), direction: "upstream" });
      }
      continue;
    }
    if (direction === "upstream" && keys.has(nodeKey(spec.to))) out.push(toEdge(spec, direction));
    if (direction === "downstream" && keys.has(nodeKey(spec.from))) out.push(toEdge(spec, direction));
  }
  return out;
}

async function chain(
  seed: TraceabilityNodeRef,
  directions: Array<"upstream" | "downstream">,
  overrides: Partial<Parameters<typeof expandGraph>[0]> = {}
) {
  return expandGraph({
    seeds: [seed],
    directions,
    maxDepth: 8,
    maxNodes: 400,
    maxEdges: 1200,
    maxNeighborsPerNode: 60,
    isVisible: () => true,
    fetchNeighbors,
    ...overrides,
  });
}

const keysOf = (result: Awaited<ReturnType<typeof chain>>) =>
  new Set(result.nodes.map(nodeKey));

/* -------------------------------------------------------------------------- */

describe("#142 généalogie — amont", () => {
  it("remonte du lot fini jusqu'au fournisseur", async () => {
    const result = await chain(LOT_FINI, ["upstream"]);
    const keys = keysOf(result);
    for (const ref of [
      OF_PARENT,
      OF_ENFANT,
      LOT_SOUS_ENSEMBLE,
      LOT_MATIERE,
      LOT_MATIERE_2,
      RECEPTION_LIGNE,
      RECEPTION,
      FOURNISSEUR,
    ]) {
      expect(keys.has(nodeKey(ref)), nodeKey(ref)).toBe(true);
    }
  });

  it("remonte du BL jusqu'à la matière fournisseur", async () => {
    const result = await chain(BL_1, ["upstream"]);
    const keys = keysOf(result);
    expect(keys.has(nodeKey(LOT_FINI))).toBe(true);
    expect(keys.has(nodeKey(OF_PARENT))).toBe(true);
    expect(keys.has(nodeKey(LOT_MATIERE))).toBe(true);
    expect(keys.has(nodeKey(FOURNISSEUR))).toBe(true);
  });

  it("remonte les DEUX lots matière consommés par le même OF", async () => {
    const result = await chain(OF_ENFANT, ["upstream"]);
    const consumed = result.edges.filter((e) => e.relation === "CONSUMED_BY" && e.target === nodeKey(OF_ENFANT));
    expect(consumed).toHaveLength(2);
    expect(consumed.map((e) => e.qty).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([20, 60]);
  });

  it("relie l'OF parent au lot fabriqué par l'OF enfant (sous-ensemble)", async () => {
    const result = await chain(OF_PARENT, ["upstream"]);
    const keys = keysOf(result);
    expect(keys.has(nodeKey(LOT_SOUS_ENSEMBLE))).toBe(true);
    expect(keys.has(nodeKey(OF_ENFANT))).toBe(true);
  });

  it("expose la réception de production comme preuve d'entrée en stock", async () => {
    const result = await chain(LOT_FINI, ["upstream"]);
    expect(keysOf(result).has(nodeKey(OF_RECEIPT))).toBe(true);
  });

  it("remonte le fractionnement de lot", async () => {
    const result = await chain(LOT_SPLIT, ["upstream"]);
    const edge = result.edges.find((e) => e.relation === "SPLIT_FROM");
    expect(edge?.source).toBe(nodeKey(LOT_MATIERE));
    expect(edge?.target).toBe(nodeKey(LOT_SPLIT));
    expect(edge?.qty).toBe(40);
  });
});

describe("#142 généalogie — aval", () => {
  it("descend du lot fournisseur jusqu'au client", async () => {
    const result = await chain(LOT_MATIERE, ["downstream"]);
    const keys = keysOf(result);
    for (const ref of [OF_ENFANT, LOT_SOUS_ENSEMBLE, OF_PARENT, LOT_FINI, BL_1, BL_2, CLIENT]) {
      expect(keys.has(nodeKey(ref)), nodeKey(ref)).toBe(true);
    }
  });

  it("montre le MÊME lot matière consommé par DEUX OF distincts", async () => {
    const result = await chain(LOT_MATIERE, ["downstream"]);
    const consumed = result.edges.filter(
      (e) => e.relation === "CONSUMED_BY" && e.source === nodeKey(LOT_MATIERE)
    );
    expect(consumed.map((e) => e.target).sort()).toEqual(["of:10", "of:11"]);
  });

  it("montre une livraison partielle sur deux BL", async () => {
    const result = await chain(LOT_FINI, ["downstream"]);
    const allocations = result.edges.filter((e) => e.relation === "ALLOCATED_TO");
    expect(allocations).toHaveLength(2);
    expect(allocations.reduce((sum, e) => sum + (e.qty ?? 0), 0)).toBe(24);
  });

  it("descend jusqu'aux opérations, machines et pointages", async () => {
    const result = await chain(OF_PARENT, ["downstream"]);
    const keys = keysOf(result);
    expect(keys.has(nodeKey(OPERATION))).toBe(true);
    expect(keys.has(nodeKey(MACHINE))).toBe(true);
    expect(keys.has(nodeKey(POINTAGE))).toBe(true);
  });

  it("expose le mouvement compensatoire, jamais une correction du mouvement d'origine", async () => {
    const result = await chain(LOT_FINI, ["downstream"]);
    const compensation = result.edges.find((e) => e.relation === "COMPENSATES");
    expect(compensation?.source).toBe(nodeKey(MVT_SORTIE));
    expect(compensation?.target).toBe(nodeKey(MVT_COMPENSATION));
    // Le mouvement d'origine reste présent : la preuve n'est pas réécrite.
    expect(keysOf(result).has(nodeKey(MVT_SORTIE))).toBe(true);
  });

  it("descend d'un OF enfant vers son OF parent", async () => {
    const result = await chain(OF_ENFANT, ["downstream"]);
    expect(keysOf(result).has(nodeKey(OF_PARENT))).toBe(true);
  });
});

describe("#142 généalogie — vue 360", () => {
  it("réunit amont et aval autour du lot fini", async () => {
    const result = await chain(LOT_FINI, ["upstream", "downstream"]);
    const keys = keysOf(result);
    expect(keys.has(nodeKey(FOURNISSEUR))).toBe(true);
    expect(keys.has(nodeKey(CLIENT))).toBe(true);
    expect(result.edges.some((e) => e.direction === "upstream")).toBe(true);
    expect(result.edges.some((e) => e.direction === "downstream")).toBe(true);
  });

  it("attache les preuves qualité et métrologie", async () => {
    const result = await chain(LOT_FINI, ["upstream", "downstream"]);
    const keys = keysOf(result);
    expect(keys.has(nodeKey(CONTROLE))).toBe(true);
    expect(keys.has(nodeKey(MESURE))).toBe(true);
    expect(keys.has(nodeKey(INSTRUMENT))).toBe(true);
    expect(keys.has(nodeKey(NC))).toBe(true);
  });

  it("remonte d'une NC vers les objets qu'elle concerne", async () => {
    const result = await chain(NC, ["upstream"]);
    expect(keysOf(result).has(nodeKey(LOT_FINI))).toBe(true);
  });

  it("part d'un instrument et atteint les mesures qu'il a produites", async () => {
    const result = await chain(INSTRUMENT, ["upstream"]);
    expect(keysOf(result).has(nodeKey(MESURE))).toBe(true);
    expect(keysOf(result).has(nodeKey(CONTROLE))).toBe(true);
  });
});

describe("#142 preuve et lacunes", () => {
  it("distingue une consommation prouvée d'une consommation seulement déclarée", async () => {
    const result = await chain(OF_PARENT, ["upstream"]);
    const proven = result.edges.filter((e) => e.relation === "CONSUMED_BY" && e.proof_level === "proven");
    const declared = result.edges.filter((e) => e.relation === "CONSUMED_BY" && e.proof_level === "declared");
    expect(proven.length).toBeGreaterThan(0);
    expect(declared).toHaveLength(1);
    expect(declared[0]?.source).toBe(nodeKey(LOT_SPLIT));
  });

  it("signale un lien historique non renseigné sans le fabriquer", async () => {
    const result = await chain(OF_PARENT, ["upstream"]);
    const unknown = result.edges.filter((e) => e.proof_level === "unknown");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.source).toBe(nodeKey(LOT_ORPHELIN));
    // Le nœud existe quand même : on montre la lacune, on ne l'efface pas.
    expect(keysOf(result).has(nodeKey(LOT_ORPHELIN))).toBe(true);
  });

  it("porte la quantité et l'unité sur les relations pertinentes", async () => {
    const result = await chain(LOT_MATIERE, ["downstream"]);
    const consumed = result.edges.find(
      (e) => e.relation === "CONSUMED_BY" && e.target === nodeKey(OF_ENFANT)
    );
    expect(consumed?.qty).toBe(60);
    expect(consumed?.unit).toBe("kg");
  });

  it("porte une date effective sur les relations datées", async () => {
    const result = await chain(LOT_FINI, ["downstream"]);
    const allocation = result.edges.find((e) => e.relation === "ALLOCATED_TO");
    expect(allocation?.effective_at).toMatch(/^2026-04/);
  });

  it("fournit un chemin de preuve complet du lot matière au client", async () => {
    const result = await chain(LOT_MATIERE, ["downstream"]);
    const path = result.paths.get(nodeKey(CLIENT));
    expect(path && path.length).toBeGreaterThanOrEqual(4);
    const edgeById = new Map(result.edges.map((e) => [e.edge_id, e]));
    const relations = (path ?? []).map((id) => edgeById.get(id)?.relation);
    expect(relations[0]).toBe("CONSUMED_BY");
    expect(relations.at(-1)).toBe("DELIVERED_TO");
  });
});

describe("#142 bornes et périmètre", () => {
  it("restreint la chaîne à une période", async () => {
    const result = await chain(LOT_MATIERE, ["downstream"], {
      periodFrom: "2026-04-01T00:00:00.000Z",
    });
    // Les consommations de février/mars sont hors période : la branche s'arrête.
    expect(keysOf(result).has(nodeKey(OF_ENFANT))).toBe(false);
  });

  it("restreint la chaîne à certains types de nœuds", async () => {
    const result = await chain(LOT_MATIERE, ["downstream"], {
      nodeTypeFilter: new Set(["of", "lot"]),
    });
    const types = new Set(result.nodes.map((n) => n.type));
    expect(types.has("client")).toBe(false);
    expect(types.has("of")).toBe(true);
  });

  it("restreint la chaîne à certaines relations", async () => {
    const result = await chain(LOT_MATIERE, ["downstream"], {
      relationFilter: new Set(["CONSUMED_BY"]),
    });
    expect(result.edges.every((e) => e.relation === "CONSUMED_BY")).toBe(true);
  });

  it("masque le client à un rôle qui n'y a pas droit, sans le laisser deviner", async () => {
    const result = await chain(LOT_FINI, ["downstream"], {
      isVisible: (type) => type !== "client",
    });
    expect(keysOf(result).has(nodeKey(CLIENT))).toBe(false);
    expect(result.edges.some((e) => e.relation === "DELIVERED_TO")).toBe(false);
    expect(result.coverage.hidden_by_permission).toBeGreaterThan(0);
  });

  it("expose une chaîne complète quand rien n'a été coupé", async () => {
    const result = await chain(LOT_SPLIT, ["upstream"], { maxDepth: 8 });
    expect(result.truncated.depth_reached).toBe(false);
    expect(result.truncated.node_budget_reached).toBe(false);
  });

  it("s'arrête proprement sur un nœud isolé", async () => {
    const result = await chain({ type: "lot", id: u(99) }, ["upstream", "downstream"]);
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
  });

  it("limite la profondeur et le signale", async () => {
    const result = await chain(LOT_MATIERE, ["downstream"], { maxDepth: 1 });
    expect(result.truncated.depth_reached).toBe(true);
    expect(keysOf(result).has(nodeKey(CLIENT))).toBe(false);
  });
});
