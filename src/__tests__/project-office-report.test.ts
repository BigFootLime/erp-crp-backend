import { describe, expect, it } from "vitest";
import {
  buildDeterministicDraft,
  computeEntryProgress,
  suggestSectionsForEvidenceType,
  suggestSectionsForWorkLog,
} from "../module/project-office/services/project-office-report.service";
import { buildReportDocx, markdownToParagraphs } from "../module/project-office/services/project-office-docx.service";

const SECTION = { section_number: "12.3", title: "Correction des bugs", description: "Vérifier le bon fonctionnement de l'application." };

describe("Progression des sections (0/25/50/75/100)", () => {
  it("VIDE sans preuve → 0 ; preuves sans texte → 25", () => {
    expect(computeEntryProgress({ status: "VIDE", ai_draft_markdown: null, validated_markdown: null }, 0)).toBe(0);
    expect(computeEntryProgress({ status: "A_DOCUMENTER", ai_draft_markdown: null, validated_markdown: null }, 2)).toBe(25);
  });
  it("brouillon IA → 50 ; relu → 75 ; validé → 100", () => {
    expect(computeEntryProgress({ status: "BROUILLON_IA", ai_draft_markdown: "x", validated_markdown: null }, 1)).toBe(50);
    expect(computeEntryProgress({ status: "A_RELIRE", ai_draft_markdown: "x", validated_markdown: null }, 1)).toBe(75);
    expect(computeEntryProgress({ status: "VALIDE", ai_draft_markdown: "x", validated_markdown: "x" }, 1)).toBe(100);
  });
});

describe("Génération evidence-based — règle anti-blabla", () => {
  it("AUCUNE matière → « À compléter », rien d'inventé", () => {
    const { markdown, hasMaterial } = buildDeterministicDraft(SECTION, { evidence: [], workLogs: [], errors: [], assets: [] });
    expect(hasMaterial).toBe(false);
    expect(markdown).toContain("nécessite encore des éléments de preuve");
    expect(markdown).toContain("À compléter");
    // Pas de prose fabriquée : aucun paragraphe affirmant un travail réalisé.
    expect(markdown).not.toMatch(/Travaux réalisés|Preuves|Erreurs rencontrées/);
  });
  it("avec matière → chaque ligne provient d'un enregistrement réel + note de traçabilité", () => {
    const { markdown, hasMaterial } = buildDeterministicDraft(SECTION, {
      evidence: [{ type: "TEST", title: "Suite vitest verte", url: "https://github.com/x/y/actions/1", description: null, relation_type: "TEST" }],
      workLogs: [{ action_type: "BUG_FIXED", title: "Fix 500 sur /gantt", description: "FK manquante", branch_name: "fix/gantt", pr_url: null, commit_sha: "abc1234def", created_at: "2026-07-10T10:00:00Z" }],
      errors: [{ title: "Erreur 500 /gantt", error_message: "column does not exist", status: "FIXED", fix_summary: "migration corrigée", severity: "HIGH", created_at: "2026-07-10T09:00:00Z", fixed_at: "2026-07-10T10:00:00Z" }],
      assets: [{ title: "Capture avant correction", description: null }],
    });
    expect(hasMaterial).toBe(true);
    expect(markdown).toContain("Fix 500 sur /gantt");
    expect(markdown).toContain("Suite vitest verte");
    expect(markdown).toContain("migration corrigée");
    expect(markdown).toContain("Capture avant correction");
    expect(markdown).toContain("Brouillon généré automatiquement à partir de 1 preuve(s), 1 entrée(s) de journal, 1 erreur(s), 1 capture(s)");
    expect(markdown).toContain("à relire, compléter et valider");
  });
});

describe("Suggestions preuves → sections du rapport", () => {
  it("mapping journal de travail", () => {
    expect(suggestSectionsForWorkLog("MIGRATION")).toEqual(["7.3", "9.4"]);
    expect(suggestSectionsForWorkLog("BUG_FIXED")).toContain("12.3");
    expect(suggestSectionsForWorkLog("DEPLOYMENT")).toEqual(["14.3", "15.1", "15.2"]);
  });
  it("mapping type de preuve", () => {
    expect(suggestSectionsForEvidenceType("SCREENSHOT")).toContain("6.3");
    expect(suggestSectionsForEvidenceType("SECURITY_SCAN")).toEqual(["11.4"]);
    expect(suggestSectionsForEvidenceType("OTHER")).toEqual([]);
  });
});

describe("Export DOCX", () => {
  it("markdownToParagraphs : titres, puces, gras", () => {
    const paras = markdownToParagraphs("## Titre\n\n- puce **grasse**\n\nTexte simple.");
    expect(paras.length).toBe(3);
  });
  it("génère un .docx réel (zip PK) avec page de garde + sections + « À compléter » sur les vides", async () => {
    const buffer = await buildReportDocx({
      title: "Rapport de projet ERP CERP — Bac+5",
      project_name: "CERP — Pilotage ERP",
      project_code: "CERP-PILOT",
      author_name: "Utilisateur #42",
      academic_year: "2025-2026",
      version: "1.0",
      confidential: true,
      sections: [
        {
          section_number: "1", title: "Analyse du besoin et du contexte", description: "Comprendre le contexte.",
          depth: 0, status: "BROUILLON_IA", markdown: "### État des sous-parties\n\n- **1.1** — BROUILLON IA", is_validated: false,
          evidence: [], assets: [],
        },
        {
          section_number: "1.1", title: "Présentation du projet", description: null,
          depth: 1, status: "VALIDE", markdown: "Le projet CERP remplace CLIPPER 07.\n\n- ERP interne\n- **Souverain**", is_validated: true,
          evidence: [{ type: "DOCUMENT", title: "ADR-0014", url: "https://github.com/x/y" }],
          assets: [{ title: "Capture dashboard", description: "Vue pilote", mime_type: "image/png", content_base64: null }],
        },
        {
          section_number: "1.2", title: "Identification du problème", description: null,
          depth: 1, status: "VIDE", markdown: null, is_validated: false, evidence: [], assets: [],
        },
      ],
      versions_history: [{ version: "1.0", title: "Première version", created_at: "2026-07-10T00:00:00Z" }],
    });
    expect(buffer.length).toBeGreaterThan(4000);
    expect(buffer.subarray(0, 2).toString("ascii")).toBe("PK"); // vrai zip OOXML
  });
});
