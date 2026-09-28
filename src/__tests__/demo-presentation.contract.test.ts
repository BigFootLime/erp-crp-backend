import { describe, expect, it } from "vitest";

import { pinPresentationFixtureVersion } from "../module/devis/repository/devis.repository";
import { actionHasCompleted, isPermittedPresentationReleaseOverride, nextPresentationAction, presentationResponse, shouldIncludePreparedQuote } from "../module/demo-presentation/services/demo-presentation.service";
import { presentationRunSchema } from "../module/demo-presentation/validators/demo-presentation.validators";
import type { PresentationScenario } from "../module/demo-presentation/types/demo-presentation.types";

const base: PresentationScenario = {
  id: "11111111-1111-4111-8111-111111111111", user_id: 7, status: "RUNNING", fixture_code: "E2E-DEMO-01",
  piece_technique_id: "22222222-2222-4222-8222-222222222222", piece_technique_version_id: "33333333-3333-4333-8333-333333333333",
  machine_id: "44444444-4444-4444-8444-444444444444", client_id: "003", devis_id: 12, commande_id: 13,
  affaire_id: 14, of_id: 15, operation_id: "55555555-5555-4555-8555-555555555555", execution_id: "66666666-6666-4666-8666-666666666666",
};

describe("demo presentation contract", () => {
  it("keeps the linear quantity-to-stop terminal transition", () => {
    expect(nextPresentationAction("QUOTE_DRAFT")).toBe("convert_quote");
    expect(nextPresentationAction("COMMANDE_CREATED")).toBe("generate_affaires");
    expect(nextPresentationAction("AFFAIRE_CREATED")).toBe("generate_ofs");
    expect(nextPresentationAction("PRODUCTION_READY")).toBe("plan");
    expect(nextPresentationAction("PLANNED")).toBe("release_operator");
    expect(nextPresentationAction("OPERATOR_READY")).toBe("start_operator");
    expect(nextPresentationAction("RUNNING")).toBe("declare_quantity");
    expect(nextPresentationAction("QUANTITY_DECLARED")).toBe("stop_operator");
    expect(nextPresentationAction("COMPLETED")).toBeNull();
    expect(presentationResponse({ ...base, status: "QUANTITY_DECLARED" })).toMatchObject({
      scenario: { status: "ACTIVE", step: "quantity_declared" }, next_action: "stop_operator",
      entities: { commande: { id: 13 }, of: { id: 15 }, execution: { id: base.execution_id } },
    });
  });

  it("recognizes a persisted target state as a read-only retry", () => {
    expect(actionHasCompleted({ ...base, status: "COMMANDE_CREATED" }, "convert_quote")).toBe(true);
    expect(actionHasCompleted({ ...base, status: "QUANTITY_DECLARED" }, "declare_quantity")).toBe(true);
    expect(actionHasCompleted({ ...base, status: "RUNNING" }, "pause_operator")).toBe(false);
  });

  it("does not accept caller-selected scenario ids at start", () => {
    expect(presentationRunSchema.safeParse({ action: "start", scenario_id: base.id }).success).toBe(false);
    expect(presentationRunSchema.safeParse({ action: "plan" }).success).toBe(false);
    expect(presentationRunSchema.safeParse({ action: "plan", scenario_id: base.id }).success).toBe(true);
  });

  it("requires native entities to be adopted only after a prepared scenario", () => {
    expect(presentationRunSchema.safeParse({ action: "prepare_client" }).success).toBe(true);
    expect(presentationRunSchema.safeParse({ action: "adopt_client", scenario_id: base.id, client_id: "003" }).success).toBe(true);
    expect(presentationRunSchema.safeParse({ action: "adopt_client", scenario_id: base.id, devis_id: 12 }).success).toBe(false);
    expect(presentationRunSchema.safeParse({ action: "prepare_devis", scenario_id: base.id }).success).toBe(true);
    expect(presentationRunSchema.safeParse({ action: "adopt_devis", scenario_id: base.id, devis_id: 12 }).success).toBe(true);
  });

  it("keeps the native quote preset available on a prepared-step retry", () => {
    expect(shouldIncludePreparedQuote("prepare_devis", "QUOTE_PREPARED")).toBe(true);
    expect(shouldIncludePreparedQuote("prepare_devis", "CLIENT_CREATED")).toBe(false);
    expect(shouldIncludePreparedQuote("adopt_devis", "QUOTE_PREPARED")).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("production recovery", () => {
  it("recovers an existing order-to-affaire and root OF before replaying workflow actions", () => {
    const source = readFileSync(resolve(process.cwd(), "src/module/demo-presentation/services/demo-presentation.service.ts"), "utf8");
    expect(source).toContain("findExistingPresentationProduction");
    expect(source).toContain("if (persisted) return updatePresentationScenario");
  });

  it("recovers from the OF's direct affaire linkage, not a secondary mapping", () => {
    const source = readFileSync(resolve(process.cwd(), "src/module/demo-presentation/repository/demo-presentation.repository.ts"), "utf8");
    expect(source).toContain("JOIN public.affaire a ON a.id = ofa.affaire_id");
    expect(source).toContain("SELECT ofa.affaire_id::bigint AS affaire_id");
    expect(source).toContain("ORDER BY a.is_principal DESC, ofa.id");
    expect(source).not.toContain("FROM public.commande_to_affaire cta");
  });

  it("exposes the delivery affaire attached to the generated root OF", () => {
    const source = readFileSync(resolve(process.cwd(), "src/module/demo-presentation/services/demo-presentation.service.ts"), "utf8");
    expect(source).toContain("out.livraison_affaire_id ?? out.principal_affaire_id");
    expect(source).toContain("findScenarioOfAffaire(ofId)");
  });
});

describe("operator continuation", () => {
  it("persists the successor segment after a resume", () => {
    const source = readFileSync(resolve(process.cwd(), "src/module/demo-presentation/services/demo-presentation.service.ts"), "utf8");
    expect(source).toContain("const resumed = await svcResumeExecution");
    expect(source).toContain('execution_id: resumed.id, status: "RUNNING"');
  });

  it("uses the explicit release service before starting a planned OF", () => {
    const source = readFileSync(resolve(process.cwd(), "src/module/demo-presentation/services/demo-presentation.service.ts"), "utf8");
    expect(source).toContain("svcReleaseOrdreFabrication");
    expect(source).toContain("isPermittedPresentationReleaseOverride");
    expect(source).toContain("DEMO_OF_RELEASE_STATE_INVALID");
    expect(source).toContain('case "PLANNED": return "release_operator"');
    expect(source).toContain('case "OPERATOR_READY": return "start_operator"');
    expect(source).toContain('release_operator: "OPERATOR_READY"');
  });

  it("creates operator pointages with the schema's canonical source", () => {
    const source = readFileSync(resolve(process.cwd(), "src/module/demo-presentation/services/demo-presentation.service.ts"), "utf8");
    expect(source).toContain('source: "CANONICAL"');
    expect(source).not.toContain('source: "demo_presentation"');
  });

  it("uses the same preview-confirm finish command as the native operator form", () => {
    const source = readFileSync(resolve(process.cwd(), "src/module/demo-presentation/services/demo-presentation.service.ts"), "utf8");
    expect(source).toContain("svcPreviewFinishOperation");
    expect(source).toContain("svcFinishOperation");
    expect(source).toContain("preview_hash: preview.preview_hash");
    expect(source).toContain("stop_active_segment: true, complete_operation: false");
    expect(source).toContain('note: null');
  });

  it("limits the presentation release override to hidden document and quality evidence", () => {
    expect(isPermittedPresentationReleaseOverride(["PROGRAM_OR_INSTRUCTION_MISSING"])).toBe(true);
    expect(isPermittedPresentationReleaseOverride(["QUALITY_PLAN_MISSING"])).toBe(true);
    expect(isPermittedPresentationReleaseOverride(["PROGRAM_OR_INSTRUCTION_MISSING", "QUALITY_PLAN_MISSING"])).toBe(true);
    expect(isPermittedPresentationReleaseOverride([])).toBe(false);
    expect(isPermittedPresentationReleaseOverride(["QUALITY_PLAN_MISSING", "MATERIAL_RESERVATION_MISSING"])).toBe(false);
    expect(presentationResponse(base).capabilities).toMatchObject({ quality_validation: false, controlled_release_override: true });
  });
});

describe("presentation recovery", () => {
  it("adopts native creations only when their synthetic provenance is exact", () => {
    const source = readFileSync(resolve(process.cwd(), "src/module/demo-presentation/repository/demo-presentation.repository.ts"), "utf8");
    expect(source).toContain("c.created_by = $1");
    expect(source).toContain("NOT EXISTS (");
    expect(source).toContain("max(dl.quantite) = 3");
    expect(source).toContain("max(dl.prix_unitaire_ht) = 240");
    expect(source).toContain("bool_and(dl.piece_technique_id = $6::uuid)");
  });

  it("uses the persisted quote and planning state rather than repeating a write", () => {
    const source = readFileSync(resolve(process.cwd(), "src/module/demo-presentation/services/demo-presentation.service.ts"), "utf8");
    expect(source).toContain('const current = await svcGetDevis');
    expect(source).toContain('entry.reason === "ALREADY_PLANNED"');
    expect(source).toContain('DEMO_QUOTE_STATE_INVALID');
  });
});

describe("presentation lock", () => {
  it("uses a non-blocking advisory lock and returns a bounded busy error", () => {
    const source = readFileSync(resolve(process.cwd(), "src/module/demo-presentation/repository/demo-presentation.repository.ts"), "utf8");
    expect(source).toContain("pg_try_advisory_lock");
    expect(source).toContain("DEMO_SCENARIO_BUSY");
    expect(source).not.toContain("pg_advisory_lock(hashtextextended");
  });

  it("resumes only the exact browser start key while serializing starts per account", () => {
    const repository = readFileSync(resolve(process.cwd(), "src/module/demo-presentation/repository/demo-presentation.repository.ts"), "utf8");
    const service = readFileSync(resolve(process.cwd(), "src/module/demo-presentation/services/demo-presentation.service.ts"), "utf8");
    expect(repository).toContain("WHERE user_id = $1 AND start_key = $2");
    expect(repository).not.toContain("WHERE user_id = $1 AND status <> 'COMPLETED'");
    expect(service).toContain("start:${params.actor.id}");
  });
});

describe("presentation fixture selection", () => {
  it("requires the same usable machine family across the applicable route and resource", () => {
    const source = readFileSync(resolve(process.cwd(), "src/module/demo-presentation/repository/demo-presentation.repository.ts"), "utf8");
    expect(source).toContain("v.date_effet IS NULL OR v.date_effet <= CURRENT_DATE");
    expect(source).toContain("upper(btrim(pto.machine_family_code)) = upper(btrim(m.machine_family_code))");
    expect(source).toContain("upper(btrim(pto.machine_family_code)) = upper(btrim(cf.machine_family_code))");
  });

  it("pins the applicable scenario version without changing another commercial line", () => {
    const draft = {
      lignes: [
        { piece_technique_id: base.piece_technique_id, piece_technique_version_id: "draft-version" },
        { piece_technique_id: "77777777-7777-4777-8777-777777777777", piece_technique_version_id: "other-version" },
      ],
    } as Parameters<typeof pinPresentationFixtureVersion>[0];
    const pinned = pinPresentationFixtureVersion(draft, {
      piece_technique_id: base.piece_technique_id,
      piece_technique_version_id: base.piece_technique_version_id,
    });
    expect(pinned.lignes[0]?.piece_technique_version_id).toBe(base.piece_technique_version_id);
    expect(pinned.lignes[1]?.piece_technique_version_id).toBe("other-version");
    expect(pinPresentationFixtureVersion(draft, undefined)).toBe(draft);
    expect(() => pinPresentationFixtureVersion(draft, {
      piece_technique_id: "88888888-8888-4888-8888-888888888888",
      piece_technique_version_id: base.piece_technique_version_id,
    })).toThrow("Le devis de démonstration ne correspond pas à la pièce technique préparée.");
  });
});
