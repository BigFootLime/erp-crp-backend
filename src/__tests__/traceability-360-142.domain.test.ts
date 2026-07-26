// #142 — Domaine Traçabilité 360 : modèle contrôlé, politique d'accès et
// moteur de graphe. Tests PURS : aucune base, aucun HTTP.

import { describe, expect, it } from "vitest";

import {
  DATA_QUALITY_LABELS,
  IMPACT_CLASSIFICATION_LABELS,
  LEGACY_TRACEABILITY_NODE_TYPES,
  NODE_TYPE_FAMILY,
  NODE_TYPE_LABELS,
  PROOF_LEVEL_LABELS,
  RELATION_LABELS,
  TRACEABILITY_NODE_TYPES,
  TRACEABILITY_RELATION_TYPES,
  authoritativeRoute,
  isBigintId,
  isTraceabilityNodeType,
  isTraceabilityRelationType,
  isUuid,
  nodeIdShapeIsValid,
  nodeKey,
  parseNodeKey,
  relationInverseLabel,
  relationLabel,
  type TraceabilityNodeType,
} from "../module/traceability/domain/traceability-model";
import {
  TRACEABILITY_CAPABILITIES,
  TRACEABILITY_LIMITS,
  assertTraceabilityCapability,
  capabilitiesForRole,
  clampDepth,
  clampEdges,
  clampNodes,
  clampSearchLimit,
  maskAmount,
  maskOperatorLabel,
  nodeTypeIsVisible,
  roleHasTraceabilityCapability,
} from "../module/traceability/domain/traceability-policy";
import {
  expandGraph,
  makeEdgeId,
  summarizeByType,
  summarizeProof,
  type NeighborEdge,
} from "../module/traceability/domain/traceability-graph";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";

function edge(partial: Partial<NeighborEdge> & Pick<NeighborEdge, "from" | "to">): NeighborEdge {
  return {
    direction: "downstream",
    relation: "CONSUMED_BY",
    proof_level: "proven",
    proof_source: "test",
    effective_at: null,
    qty: null,
    unit: null,
    correlation_id: null,
    evidence_ref: null,
    historical_status: null,
    meta: null,
    ...partial,
  };
}

const allowAll = () => true;

/* -------------------------------------------------------------------------- */
/* 1) Modèle                                                                  */
/* -------------------------------------------------------------------------- */

describe("#142 modèle de traçabilité", () => {
  it("couvre toute la chaîne fournisseur → client dans les types de nœuds", () => {
    const required: TraceabilityNodeType[] = [
      "fournisseur",
      "commande_fournisseur",
      "reception_fournisseur",
      "reception_ligne",
      "reception_inspection",
      "article",
      "lot",
      "stock_movement",
      "material_consumption",
      "of",
      "of_operation",
      "pointage",
      "machine",
      "of_receipt",
      "quality_control",
      "quality_measurement",
      "metrology_equipment",
      "metrology_certificate",
      "non_conformity",
      "derogation",
      "release_decision",
      "reservation",
      "bon_livraison",
      "delivery_proof",
      "client",
      "document",
      "asbuilt_pack",
    ];
    for (const type of required) {
      expect(TRACEABILITY_NODE_TYPES).toContain(type);
    }
  });

  it("donne un libellé français et une famille à CHAQUE type de nœud", () => {
    for (const type of TRACEABILITY_NODE_TYPES) {
      expect(NODE_TYPE_LABELS[type], type).toBeTruthy();
      expect(NODE_TYPE_FAMILY[type], type).toBeTruthy();
    }
  });

  it("donne un libellé direct ET inverse à CHAQUE relation", () => {
    for (const relation of TRACEABILITY_RELATION_TYPES) {
      expect(RELATION_LABELS[relation], relation).toBeTruthy();
      expect(relationLabel(relation)).not.toBe(relation);
      expect(relationInverseLabel(relation)).not.toBe(relation);
    }
  });

  it("expose le vocabulaire métier attendu par la Qualité", () => {
    const labels = TRACEABILITY_RELATION_TYPES.flatMap((r) => [
      relationLabel(r),
      relationInverseLabel(r),
    ]);
    for (const expected of [
      "commandé auprès de",
      "reçu dans",
      "a créé le lot",
      "issu de",
      "consommé par",
      "entrée matière de",
      "produit par",
      "OF enfant de",
      "utilise la version",
      "exécuté sur",
      "pointé dans",
      "contrôlé par",
      "mesuré avec",
      "concerné par une NC",
      "libéré par",
      "bloqué par",
      "déplacé par",
      "réservé pour",
      "alloué à",
      "livré dans",
      "livré au client",
      "documenté par",
      "fractionné depuis",
      "fusionné depuis",
      "transformé depuis",
      "compense",
      "remplace",
    ]) {
      expect(labels, expected).toContain(expected);
    }
  });

  it("garde les types du contrat historique valides", () => {
    for (const type of LEGACY_TRACEABILITY_NODE_TYPES) {
      expect(isTraceabilityNodeType(type)).toBe(true);
    }
  });

  it("rejette un type ou une relation inconnue", () => {
    expect(isTraceabilityNodeType("facture_fantome")).toBe(false);
    expect(isTraceabilityRelationType("MAGIC")).toBe(false);
    expect(isTraceabilityNodeType(42)).toBe(false);
  });

  it("compose et décompose une clé de nœud", () => {
    const ref = { type: "lot" as const, id: UUID_A };
    expect(nodeKey(ref)).toBe(`lot:${UUID_A}`);
    expect(parseNodeKey(`lot:${UUID_A}`)).toEqual(ref);
    expect(parseNodeKey("pas-une-cle")).toBeNull();
    expect(parseNodeKey(":vide")).toBeNull();
    expect(parseNodeKey("inconnu:1")).toBeNull();
  });

  it("valide la forme des identifiants pour éviter un cast SQL raté", () => {
    expect(isUuid(UUID_A)).toBe(true);
    expect(isUuid("42")).toBe(false);
    expect(isBigintId("42")).toBe(true);
    expect(isBigintId(UUID_A)).toBe(false);

    expect(nodeIdShapeIsValid({ type: "lot", id: UUID_A })).toBe(true);
    // Un bigint envoyé là où PostgreSQL attend un uuid : refusé AVANT la requête.
    expect(nodeIdShapeIsValid({ type: "lot", id: "42" })).toBe(false);
    expect(nodeIdShapeIsValid({ type: "of", id: "42" })).toBe(true);
    expect(nodeIdShapeIsValid({ type: "of", id: UUID_A })).toBe(false);
    expect(nodeIdShapeIsValid({ type: "client", id: "ACM" })).toBe(true);
    expect(nodeIdShapeIsValid({ type: "lot", id: "   " })).toBe(false);
  });

  it("route vers la fiche autoritaire, jamais vers un écran inexistant", () => {
    expect(authoritativeRoute({ type: "of", id: "12" })).toBe("/production/of/12");
    expect(authoritativeRoute({ type: "non_conformity", id: UUID_A })).toBe(
      `/qualite/non-conformites/${UUID_A}`
    );
    expect(authoritativeRoute({ type: "lot", id: UUID_A })).toBe(`/stock/lots/${UUID_A}`);
    // Pas d'écran dédié : on n'invente pas une URL morte.
    expect(authoritativeRoute({ type: "quality_measurement", id: UUID_A })).toBeNull();
    expect(authoritativeRoute({ type: "pointage", id: UUID_A })).toBeNull();
  });

  it("nomme les anomalies de données et les classes d'impact en français", () => {
    expect(DATA_QUALITY_LABELS.LOT_WITHOUT_ORIGIN).toMatch(/origine/i);
    expect(DATA_QUALITY_LABELS.CONSUMPTION_WITHOUT_POSTED_MOVEMENT).toMatch(/comptabilis/i);
    expect(IMPACT_CLASSIFICATION_LABELS.CONFIRMED).toBe("Impact confirmé");
    expect(IMPACT_CLASSIFICATION_LABELS.NO_PROVEN_IMPACT).toBe("Sans impact prouvé");
    expect(PROOF_LEVEL_LABELS.unknown).toBe("Lien historique non renseigné");
  });
});

/* -------------------------------------------------------------------------- */
/* 2) Politique d'accès                                                       */
/* -------------------------------------------------------------------------- */

describe("#142 RBAC — refus par défaut", () => {
  it("refuse tout à un rôle vide, inconnu ou nul", () => {
    for (const role of [null, undefined, "", "   ", "role_inexistant"]) {
      for (const cap of TRACEABILITY_CAPABILITIES) {
        expect(roleHasTraceabilityCapability(role, cap), `${String(role)}/${cap}`).toBe(false);
      }
    }
  });

  it("accorde la lecture à l'atelier, au magasin, à la qualité et à l'ADV", () => {
    for (const role of ["Opérateur atelier", "Magasinier", "Responsable Qualité", "ADV"]) {
      expect(roleHasTraceabilityCapability(role, "read"), role).toBe(true);
    }
  });

  it("réserve l'analyse d'impact à la qualité, la métrologie et les méthodes", () => {
    expect(roleHasTraceabilityCapability("Responsable Qualité", "impact")).toBe(true);
    expect(roleHasTraceabilityCapability("Métrologue", "impact")).toBe(true);
    expect(roleHasTraceabilityCapability("Opérateur atelier", "impact")).toBe(false);
    expect(roleHasTraceabilityCapability("Magasinier", "impact")).toBe(false);
  });

  it("réserve l'export et l'audit à la qualité et à la direction", () => {
    expect(roleHasTraceabilityCapability("Directeur", "export")).toBe(true);
    expect(roleHasTraceabilityCapability("Responsable QSE", "audit")).toBe(true);
    expect(roleHasTraceabilityCapability("Opérateur atelier", "export")).toBe(false);
    expect(roleHasTraceabilityCapability("Magasinier", "audit")).toBe(false);
  });

  it("sépare la génération et le téléchargement du dossier as-built", () => {
    expect(roleHasTraceabilityCapability("ADV", "asbuilt_download")).toBe(true);
    expect(roleHasTraceabilityCapability("ADV", "asbuilt_generate")).toBe(false);
    expect(roleHasTraceabilityCapability("Responsable Qualité", "asbuilt_generate")).toBe(true);
  });

  it("n'accorde AUCUN accès métier implicite à l'administrateur technique", () => {
    // « Technicien informatique » n'est pas « Administrateur » : administrer le
    // système ne donne pas le droit de lire les prix client.
    const role = "Technicien informatique";
    expect(roleHasTraceabilityCapability(role, "read")).toBe(false);
    expect(roleHasTraceabilityCapability(role, "financial_read")).toBe(false);
    expect(roleHasTraceabilityCapability(role, "customer_data_read")).toBe(false);
  });

  it("lève une 403 typée quand la capacité manque", () => {
    expect(() => assertTraceabilityCapability("Opérateur atelier", "impact")).toThrowError(
      /TRACEABILITY_CAPABILITY_REQUIRED|capacité/i
    );
    expect(() => assertTraceabilityCapability("Responsable Qualité", "impact")).not.toThrow();
  });

  it("masque un type de nœud interdit sans révéler son existence", () => {
    const atelier = capabilitiesForRole("Opérateur atelier");
    expect(nodeTypeIsVisible(atelier, "lot")).toBe(true);
    expect(nodeTypeIsVisible(atelier, "of")).toBe(true);
    // L'atelier n'a pas à voir le client ni le fournisseur depuis la chaîne.
    expect(nodeTypeIsVisible(atelier, "client")).toBe(false);
    expect(nodeTypeIsVisible(atelier, "fournisseur")).toBe(false);
    expect(nodeTypeIsVisible(atelier, "devis")).toBe(false);

    const adv = capabilitiesForRole("ADV");
    expect(nodeTypeIsVisible(adv, "client")).toBe(true);
    expect(nodeTypeIsVisible(adv, "commande")).toBe(true);

    const achats = capabilitiesForRole("Responsable Achats");
    expect(nodeTypeIsVisible(achats, "fournisseur")).toBe(true);
    expect(nodeTypeIsVisible(achats, "client")).toBe(false);
  });

  it("ne montre rien du tout sans la capacité de lecture", () => {
    const none = capabilitiesForRole("role_inexistant");
    for (const type of TRACEABILITY_NODE_TYPES) {
      expect(nodeTypeIsVisible(none, type), type).toBe(false);
    }
  });

  it("pseudonymise l'opérateur sans détruire la preuve (RGPD)", () => {
    const atelier = capabilitiesForRole("Opérateur atelier");
    const rh = capabilitiesForRole("Responsable RH");
    expect(maskOperatorLabel(atelier, 42, "Jean Dupont")).toBe("Opérateur #42");
    expect(maskOperatorLabel(rh, 42, "Jean Dupont")).toBe("Jean Dupont");
    expect(maskOperatorLabel(atelier, null, null)).toBeNull();
  });

  it("masque les montants sans droit financier", () => {
    expect(maskAmount(capabilitiesForRole("Opérateur atelier"), 1234)).toBeNull();
    expect(maskAmount(capabilitiesForRole("Comptable"), 1234)).toBe(1234);
  });

  it("borne les paramètres serveur, sans possibilité de les élargir", () => {
    expect(clampDepth(999)).toBe(TRACEABILITY_LIMITS.MAX_DEPTH);
    expect(clampDepth(-5)).toBe(0);
    expect(clampDepth(undefined)).toBe(TRACEABILITY_LIMITS.DEFAULT_DEPTH);
    expect(clampNodes(100000)).toBe(TRACEABILITY_LIMITS.MAX_NODES);
    expect(clampNodes(0)).toBe(1);
    expect(clampEdges(999999)).toBe(TRACEABILITY_LIMITS.MAX_EDGES);
    expect(clampSearchLimit(10000)).toBe(TRACEABILITY_LIMITS.SEARCH_MAX_LIMIT);
    expect(clampSearchLimit(Number.NaN)).toBe(TRACEABILITY_LIMITS.SEARCH_DEFAULT_LIMIT);
  });
});

/* -------------------------------------------------------------------------- */
/* 3) Moteur de graphe                                                        */
/* -------------------------------------------------------------------------- */

describe("#142 moteur de graphe", () => {
  const seed = { type: "lot" as const, id: UUID_A };

  it("identifie une arête par son enregistrement de preuve, pas seulement par ses extrémités", () => {
    const a = makeEdgeId(
      edge({ from: seed, to: { type: "of", id: "1" }, evidence_ref: "cons-1" })
    );
    const b = makeEdgeId(
      edge({ from: seed, to: { type: "of", id: "1" }, evidence_ref: "cons-2" })
    );
    // Deux consommations du MÊME lot par le MÊME OF à deux dates sont deux
    // faits distincts : les fusionner perdrait la quantité réelle.
    expect(a).not.toBe(b);
  });

  it("parcourt niveau par niveau : un appel par direction et par profondeur", async () => {
    const calls: Array<{ size: number; direction: string }> = [];
    const result = await expandGraph({
      seeds: [seed],
      directions: ["downstream"],
      maxDepth: 3,
      maxNodes: 100,
      maxEdges: 400,
      maxNeighborsPerNode: 50,
      isVisible: allowAll,
      fetchNeighbors: async (refs, direction) => {
        calls.push({ size: refs.length, direction });
        if (refs[0]?.type === "lot") {
          return [
            edge({ from: refs[0], to: { type: "of", id: "1" }, evidence_ref: "e1" }),
            edge({ from: refs[0], to: { type: "of", id: "2" }, evidence_ref: "e2" }),
          ];
        }
        if (refs[0]?.type === "of") {
          return refs.map((r, i) =>
            edge({
              from: r,
              to: { type: "lot", id: i === 0 ? UUID_B : UUID_C },
              relation: "PRODUCED_BY",
              evidence_ref: `p${i}`,
            })
          );
        }
        return [];
      },
    });

    // 3 profondeurs × 1 direction = 3 appels, PAS un appel par nœud.
    expect(calls.length).toBeLessThanOrEqual(3);
    // Le niveau 2 remet les DEUX OF dans le même appel.
    expect(calls[1]?.size).toBe(2);
    expect(result.nodes.length).toBeGreaterThan(1);
  });

  it("respecte la profondeur maximale et signale la troncature", async () => {
    let depth = 0;
    const result = await expandGraph({
      seeds: [seed],
      directions: ["downstream"],
      maxDepth: 2,
      maxNodes: 100,
      maxEdges: 100,
      maxNeighborsPerNode: 10,
      isVisible: allowAll,
      fetchNeighbors: async (refs) => {
        depth += 1;
        return [
          edge({
            from: refs[0],
            to: { type: "lot", id: `${UUID_B.slice(0, -1)}${depth}` },
            relation: "SPLIT_FROM",
            evidence_ref: `g${depth}`,
          }),
        ];
      },
    });

    expect(result.truncated.depth_reached).toBe(true);
    expect(result.issues.some((i) => i.code === "TRUNCATED_BY_LIMITS")).toBe(true);
  });

  it("respecte le plafond de nœuds et n'ajoute pas d'arête pendante", async () => {
    const result = await expandGraph({
      seeds: [seed],
      directions: ["downstream"],
      maxDepth: 3,
      maxNodes: 3,
      maxEdges: 100,
      maxNeighborsPerNode: 50,
      isVisible: allowAll,
      fetchNeighbors: async (refs) =>
        Array.from({ length: 10 }, (_, i) =>
          edge({
            from: refs[0],
            to: { type: "of", id: String(i + 1) },
            evidence_ref: `n${refs[0].id}-${i}`,
          })
        ),
    });

    expect(result.nodes.length).toBeLessThanOrEqual(3);
    expect(result.truncated.node_budget_reached).toBe(true);
    // Toute arête pointe vers un nœud réellement présent.
    const keys = new Set(result.nodes.map(nodeKey));
    for (const e of result.edges) {
      expect(keys.has(e.target), e.edge_id).toBe(true);
      expect(keys.has(e.source), e.edge_id).toBe(true);
    }
  });

  it("respecte le plafond d'arêtes", async () => {
    const result = await expandGraph({
      seeds: [seed],
      directions: ["downstream"],
      maxDepth: 2,
      maxNodes: 500,
      maxEdges: 4,
      maxNeighborsPerNode: 50,
      isVisible: allowAll,
      fetchNeighbors: async (refs) =>
        Array.from({ length: 20 }, (_, i) =>
          edge({ from: refs[0], to: { type: "of", id: String(i + 1) }, evidence_ref: `x${i}` })
        ),
    });
    expect(result.edges.length).toBeLessThanOrEqual(4);
    expect(result.truncated.edge_budget_reached).toBe(true);
  });

  it("plafonne les voisins par branche et dit combien ont été coupés", async () => {
    const result = await expandGraph({
      seeds: [seed],
      directions: ["downstream"],
      maxDepth: 1,
      maxNodes: 500,
      maxEdges: 500,
      maxNeighborsPerNode: 3,
      isVisible: allowAll,
      fetchNeighbors: async (refs) =>
        Array.from({ length: 10 }, (_, i) =>
          edge({ from: refs[0], to: { type: "of", id: String(i + 1) }, evidence_ref: `c${i}` })
        ),
    });

    const branch = result.truncated.branches.find((b) => b.reason === "neighbor_cap");
    expect(branch).toBeDefined();
    expect(branch?.dropped).toBe(7);
    expect(branch?.node_id).toBe(nodeKey(seed));
  });

  it("détecte un cycle sans boucler à l'infini", async () => {
    const result = await expandGraph({
      seeds: [seed],
      directions: ["downstream"],
      maxDepth: 8,
      maxNodes: 100,
      maxEdges: 100,
      maxNeighborsPerNode: 10,
      isVisible: allowAll,
      fetchNeighbors: async (refs) => {
        const current = refs[0];
        const next = current.id === UUID_A ? UUID_B : UUID_A;
        return [
          edge({
            from: current,
            to: { type: "lot", id: next },
            relation: "TRANSFORMED_FROM",
            evidence_ref: `cy-${current.id}`,
          }),
        ];
      },
    });

    expect(result.issues.some((i) => i.code === "CYCLE_DETECTED")).toBe(true);
    expect(result.nodes.length).toBe(2);
  });

  it("retire un nœud interdit AVEC son arête (aucune inférence possible)", async () => {
    const result = await expandGraph({
      seeds: [seed],
      directions: ["downstream"],
      maxDepth: 2,
      maxNodes: 50,
      maxEdges: 50,
      maxNeighborsPerNode: 20,
      isVisible: (type) => type !== "client",
      fetchNeighbors: async (refs) => [
        edge({ from: refs[0], to: { type: "client", id: "ACM" }, relation: "DELIVERED_TO", evidence_ref: "d1" }),
        edge({ from: refs[0], to: { type: "of", id: "7" }, evidence_ref: "d2" }),
      ],
    });

    expect(result.nodes.some((n) => n.type === "client")).toBe(false);
    expect(result.edges.some((e) => e.target.includes("client"))).toBe(false);
    expect(result.coverage.hidden_by_permission).toBeGreaterThan(0);
    expect(result.issues.some((i) => i.code === "TRUNCATED_BY_PERMISSIONS")).toBe(true);
  });

  it("refuse un seed invisible", async () => {
    const result = await expandGraph({
      seeds: [seed],
      directions: ["downstream"],
      maxDepth: 2,
      maxNodes: 50,
      maxEdges: 50,
      maxNeighborsPerNode: 20,
      isVisible: () => false,
      fetchNeighbors: async () => [],
    });
    expect(result.nodes).toHaveLength(0);
    expect(result.coverage.hidden_by_permission).toBe(1);
  });

  it("applique le filtre de type de nœud", async () => {
    const result = await expandGraph({
      seeds: [seed],
      directions: ["downstream"],
      maxDepth: 1,
      maxNodes: 50,
      maxEdges: 50,
      maxNeighborsPerNode: 20,
      isVisible: allowAll,
      nodeTypeFilter: new Set<TraceabilityNodeType>(["of"]),
      fetchNeighbors: async (refs) => [
        edge({ from: refs[0], to: { type: "of", id: "1" }, evidence_ref: "f1" }),
        edge({ from: refs[0], to: { type: "bon_livraison", id: UUID_B }, evidence_ref: "f2" }),
      ],
    });
    expect(result.nodes.map((n) => n.type).sort()).toEqual(["lot", "of"]);
    expect(result.coverage.filtered_out).toBe(1);
  });

  it("applique le filtre de relation", async () => {
    const result = await expandGraph({
      seeds: [seed],
      directions: ["downstream"],
      maxDepth: 1,
      maxNodes: 50,
      maxEdges: 50,
      maxNeighborsPerNode: 20,
      isVisible: allowAll,
      relationFilter: new Set(["CONSUMED_BY" as const]),
      fetchNeighbors: async (refs) => [
        edge({ from: refs[0], to: { type: "of", id: "1" }, relation: "CONSUMED_BY", evidence_ref: "r1" }),
        edge({ from: refs[0], to: { type: "of", id: "2" }, relation: "PRODUCED_BY", evidence_ref: "r2" }),
      ],
    });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.relation).toBe("CONSUMED_BY");
  });

  it("filtre par période mais garde les arêtes SANS date (lacune ≠ exclusion)", async () => {
    const result = await expandGraph({
      seeds: [seed],
      directions: ["downstream"],
      maxDepth: 1,
      maxNodes: 50,
      maxEdges: 50,
      maxNeighborsPerNode: 20,
      isVisible: allowAll,
      periodFrom: "2026-01-01T00:00:00.000Z",
      fetchNeighbors: async (refs) => [
        edge({ from: refs[0], to: { type: "of", id: "1" }, effective_at: "2025-06-01T00:00:00.000Z", evidence_ref: "old" }),
        edge({ from: refs[0], to: { type: "of", id: "2" }, effective_at: "2026-06-01T00:00:00.000Z", evidence_ref: "new" }),
        edge({ from: refs[0], to: { type: "of", id: "3" }, effective_at: null, evidence_ref: "undated" }),
      ],
    });
    const targets = result.edges.map((e) => e.target).sort();
    expect(targets).toEqual(["of:2", "of:3"]);
  });

  it("construit le chemin de preuve le plus court depuis le seed", async () => {
    const result = await expandGraph({
      seeds: [seed],
      directions: ["downstream"],
      maxDepth: 3,
      maxNodes: 50,
      maxEdges: 50,
      maxNeighborsPerNode: 20,
      isVisible: allowAll,
      fetchNeighbors: async (refs) => {
        const current = refs[0];
        if (current.type === "lot" && current.id === UUID_A) {
          return [edge({ from: current, to: { type: "of", id: "1" }, evidence_ref: "s1" })];
        }
        if (current.type === "of") {
          return [
            edge({
              from: current,
              to: { type: "lot", id: UUID_B },
              relation: "PRODUCED_BY",
              evidence_ref: "s2",
            }),
          ];
        }
        if (current.type === "lot" && current.id === UUID_B) {
          return [
            edge({
              from: current,
              to: { type: "bon_livraison", id: UUID_C },
              relation: "ALLOCATED_TO",
              evidence_ref: "s3",
            }),
          ];
        }
        return [];
      },
    });

    const path = result.paths.get(`bon_livraison:${UUID_C}`);
    expect(path).toHaveLength(3);
    expect(result.depthByNode.get(`bon_livraison:${UUID_C}`)).toBe(3);
    expect(result.paths.get(nodeKey(seed))).toHaveLength(0);
  });

  it("compte les nœuds par type et les niveaux de preuve", async () => {
    const result = await expandGraph({
      seeds: [seed],
      directions: ["downstream"],
      maxDepth: 1,
      maxNodes: 50,
      maxEdges: 50,
      maxNeighborsPerNode: 20,
      isVisible: allowAll,
      fetchNeighbors: async (refs) => [
        edge({ from: refs[0], to: { type: "of", id: "1" }, proof_level: "proven", evidence_ref: "p1" }),
        edge({ from: refs[0], to: { type: "of", id: "2" }, proof_level: "declared", evidence_ref: "p2" }),
        edge({ from: refs[0], to: { type: "of", id: "3" }, proof_level: "unknown", evidence_ref: "p3" }),
      ],
    });

    expect(summarizeByType(result.nodes)).toEqual([
      { type: "of", count: 3 },
      { type: "lot", count: 1 },
    ]);
    expect(summarizeProof(result.edges)).toEqual({ proven: 1, declared: 1, unknown: 1 });
  });

  it("dédoublonne une arête identique renvoyée par les deux directions", async () => {
    const result = await expandGraph({
      seeds: [seed],
      directions: ["upstream", "downstream"],
      maxDepth: 1,
      maxNodes: 50,
      maxEdges: 50,
      maxNeighborsPerNode: 20,
      isVisible: allowAll,
      fetchNeighbors: async (refs) => [
        edge({
          from: refs[0],
          to: { type: "quality_control", id: UUID_D },
          relation: "CONTROLLED_BY",
          direction: "lateral",
          evidence_ref: "lat-1",
        }),
      ],
    });
    expect(result.edges).toHaveLength(1);
  });

  it("gère une frontière vide sans exploser", async () => {
    const result = await expandGraph({
      seeds: [seed],
      directions: ["downstream"],
      maxDepth: 4,
      maxNodes: 50,
      maxEdges: 50,
      maxNeighborsPerNode: 20,
      isVisible: allowAll,
      fetchNeighbors: async () => [],
    });
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
    expect(result.truncated.depth_reached).toBe(false);
    expect(result.issues.filter((i) => i.code === "TRUNCATED_BY_LIMITS")).toHaveLength(0);
  });
});
