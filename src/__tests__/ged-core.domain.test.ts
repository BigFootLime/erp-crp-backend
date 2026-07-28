// GED centrale CERP (ADR-0037) — tests du domaine.
//
// Ces tests ne touchent ni la base ni le disque : ils valident les règles qui
// doivent tenir quel que soit l'environnement.

import { describe, expect, it } from "vitest";

import {
  assertAcceptedFile,
  fileKindForExtension,
  hasValidSignature,
  isAlwaysRejectedExtension,
} from "../module/ged/domain/ged-content";
import {
  assertDistinctApprover,
  assertGedCapability,
  assertVersionMutable,
  assertVersionTransition,
  formatDocumentCode,
  isVersionFrozen,
  roleHasGedCapability,
  sanitizeOriginalName,
} from "../module/ged/domain/ged-policy";
import { storageKeyForSha256 } from "../module/ged/services/ged-vault.service";
import { HttpError } from "../utils/httpError";

const PDF_HEADER = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WINDOWS_EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

const PDF_RULES = {
  class_key: "PLAN_CLIENT",
  allowed_mime_types: ["application/pdf"],
  allowed_extensions: [".pdf"],
  max_size_bytes: 1024 * 1024,
};

function pdfFile(overrides: Record<string, unknown> = {}) {
  return {
    buffer: PDF_HEADER,
    originalname: "plan.pdf",
    mimetype: "application/pdf",
    size: PDF_HEADER.byteLength,
    ...overrides,
  };
}

describe("GED — capacités RBAC", () => {
  it("refuse par défaut un rôle inconnu ou vide", () => {
    expect(roleHasGedCapability(null, "read")).toBe(false);
    expect(roleHasGedCapability("", "read")).toBe(false);
    expect(roleHasGedCapability("stagiaire-externe", "read")).toBe(false);
  });

  it("accorde la lecture aux rôles opérationnels", () => {
    expect(roleHasGedCapability("Methodes", "read")).toBe(true);
    expect(roleHasGedCapability("Qualite", "read")).toBe(true);
    expect(roleHasGedCapability("Atelier", "read")).toBe(true);
  });

  it("garde l'approbation et la publication étroites", () => {
    expect(roleHasGedCapability("Atelier", "approve")).toBe(false);
    expect(roleHasGedCapability("Magasinier", "publish")).toBe(false);
    expect(roleHasGedCapability("Responsable Qualite", "approve")).toBe(true);
    expect(roleHasGedCapability("Administrateur", "publish")).toBe(true);
  });

  it("distingue export et download", () => {
    expect(roleHasGedCapability("Magasinier", "download")).toBe(true);
    expect(roleHasGedCapability("Magasinier", "export")).toBe(false);
  });

  it("lève une 403 explicite", () => {
    expect(() => assertGedCapability("Atelier", "approve")).toThrowError(HttpError);
    try {
      assertGedCapability("Atelier", "approve");
    } catch (err) {
      expect((err as HttpError).status).toBe(403);
      expect((err as HttpError).code).toBe("GED_CAPABILITY_REQUIRED");
    }
  });
});

describe("GED — cycle de vie", () => {
  it("suit le chemin nominal", () => {
    expect(() => assertVersionTransition("BROUILLON", "EN_REVUE")).not.toThrow();
    expect(() => assertVersionTransition("EN_REVUE", "APPROUVE")).not.toThrow();
    expect(() => assertVersionTransition("APPROUVE", "APPLICABLE")).not.toThrow();
    expect(() => assertVersionTransition("APPLICABLE", "OBSOLETE")).not.toThrow();
  });

  it("interdit de rouvrir une version approuvée en brouillon", () => {
    expect(() => assertVersionTransition("APPROUVE", "BROUILLON")).toThrowError(HttpError);
  });

  it("interdit toute sortie d'OBSOLETE", () => {
    for (const target of ["BROUILLON", "EN_REVUE", "APPROUVE", "APPLICABLE"] as const) {
      expect(() => assertVersionTransition("OBSOLETE", target)).toThrowError(HttpError);
    }
  });

  it("gèle le contenu dès l'approbation", () => {
    expect(isVersionFrozen("BROUILLON")).toBe(false);
    expect(isVersionFrozen("EN_REVUE")).toBe(false);
    expect(isVersionFrozen("APPROUVE")).toBe(true);
    expect(isVersionFrozen("APPLICABLE")).toBe(true);
    expect(() => assertVersionMutable("APPLICABLE")).toThrowError(HttpError);
    expect(() => assertVersionMutable("BROUILLON")).not.toThrow();
  });
});

describe("GED — séparation des tâches", () => {
  it("refuse qu'un déposant approuve sa propre version", () => {
    expect(() => assertDistinctApprover(42, 42)).toThrowError(HttpError);
    try {
      assertDistinctApprover(42, 42);
    } catch (err) {
      expect((err as HttpError).code).toBe("GED_APPROVAL_SELF");
    }
  });

  it("accepte un approbateur distinct", () => {
    expect(() => assertDistinctApprover(42, 7)).not.toThrow();
    expect(() => assertDistinctApprover(null, 7)).not.toThrow();
  });
});

describe("GED — codification", () => {
  it("préfixe par domaine et pad sur 6 chiffres", () => {
    expect(formatDocumentCode("TECHNIQUE", 1)).toBe("DT-000001");
    expect(formatDocumentCode("QUALITE", 1234)).toBe("DQ-001234");
    expect(formatDocumentCode("INCONNU", 9)).toBe("DX-000009");
  });

  it("refuse une séquence invalide", () => {
    expect(() => formatDocumentCode("TECHNIQUE", 0)).toThrowError(HttpError);
  });
});

describe("GED — assainissement des noms", () => {
  it("neutralise une tentative de path traversal", () => {
    expect(sanitizeOriginalName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeOriginalName("..\\..\\windows\\system32\\cmd.exe")).toBe("cmd.exe");
  });

  it("ne renvoie jamais une chaîne vide", () => {
    expect(sanitizeOriginalName("")).toBe("document");
    expect(sanitizeOriginalName(null)).toBe("document");
    expect(sanitizeOriginalName("...")).toBe("document");
  });

  it("borne la longueur", () => {
    expect(sanitizeOriginalName(`${"a".repeat(500)}.pdf`).length).toBeLessThanOrEqual(180);
  });

  it("retire les caractères de contrôle", () => {
    const withControl = `plan${String.fromCharCode(0)}${String.fromCharCode(9)}.pdf`;
    const result = sanitizeOriginalName(withControl);
    expect(result).not.toContain(String.fromCharCode(0));
    expect(result).not.toContain(String.fromCharCode(9));
  });
});

describe("GED — contrôle de contenu", () => {
  it("accepte un PDF cohérent", () => {
    const accepted = assertAcceptedFile(pdfFile(), PDF_RULES);
    expect(accepted.extension).toBe(".pdf");
    expect(accepted.kind).toBe("pdf");
  });

  it("refuse un exécutable renommé en .pdf", () => {
    try {
      assertAcceptedFile(pdfFile({ buffer: WINDOWS_EXE, size: WINDOWS_EXE.byteLength }), PDF_RULES);
      throw new Error("aurait dû être refusé");
    } catch (err) {
      expect((err as HttpError).status).toBe(415);
      expect((err as HttpError).code).toBe("GED_FILE_SIGNATURE");
    }
  });

  it("refuse une extension hors allowlist de classe", () => {
    try {
      assertAcceptedFile(pdfFile({ originalname: "photo.png", buffer: PNG_HEADER }), PDF_RULES);
      throw new Error("aurait dû être refusé");
    } catch (err) {
      expect((err as HttpError).code).toBe("GED_FILE_TYPE");
    }
  });

  it("refuse un MIME hors allowlist de classe", () => {
    try {
      assertAcceptedFile(pdfFile({ mimetype: "application/octet-stream" }), PDF_RULES);
      throw new Error("aurait dû être refusé");
    } catch (err) {
      expect((err as HttpError).code).toBe("GED_FILE_TYPE");
    }
  });

  it("refuse un fichier trop gros", () => {
    try {
      assertAcceptedFile(pdfFile({ size: PDF_RULES.max_size_bytes + 1 }), PDF_RULES);
      throw new Error("aurait dû être refusé");
    } catch (err) {
      expect((err as HttpError).status).toBe(413);
    }
  });

  it("refuse un fichier vide", () => {
    try {
      assertAcceptedFile(pdfFile({ buffer: Buffer.alloc(0), size: 0 }), PDF_RULES);
      throw new Error("aurait dû être refusé");
    } catch (err) {
      expect((err as HttpError).status).toBe(400);
    }
  });

  it("refuse les extensions dangereuses même si une classe les autorisait", () => {
    for (const ext of [".exe", ".docm", ".svg", ".js", ".bat", ".jar"]) {
      expect(isAlwaysRejectedExtension(ext)).toBe(true);
    }
    try {
      assertAcceptedFile(pdfFile({ originalname: "macro.docm" }), {
        ...PDF_RULES,
        allowed_extensions: [".docm"],
        allowed_mime_types: ["application/pdf"],
      });
      throw new Error("aurait dû être refusé");
    } catch (err) {
      expect((err as HttpError).code).toBe("GED_FILE_TYPE");
    }
  });

  it("valide les signatures connues", () => {
    expect(hasValidSignature(PDF_HEADER, "pdf")).toBe(true);
    expect(hasValidSignature(PNG_HEADER, "png")).toBe(true);
    expect(hasValidSignature(PNG_HEADER, "pdf")).toBe(false);
    expect(hasValidSignature(WINDOWS_EXE, "binary")).toBe(false);
    expect(hasValidSignature(Buffer.from("G01 X10 Y20", "utf8"), "text")).toBe(true);
    expect(hasValidSignature(Buffer.from([0x47, 0x00, 0x30]), "text")).toBe(false);
  });

  it("reconnaît les extensions métier", () => {
    expect(fileKindForExtension(".nc")).toBe("text");
    expect(fileKindForExtension(".mcam")).toBe("binary");
    expect(fileKindForExtension(".inconnu")).toBeNull();
  });
});

describe("GED — clé de coffre", () => {
  it("répartit par empreinte et n'expose aucune sémantique métier", () => {
    const sha = "a".repeat(64);
    expect(storageKeyForSha256(sha)).toBe(`vault/sha256/aa/aa/${sha}`);
  });

  it("refuse une empreinte invalide", () => {
    expect(() => storageKeyForSha256("pas-une-empreinte")).toThrowError(HttpError);
    expect(() => storageKeyForSha256("../../escape")).toThrowError(HttpError);
  });
});

/*
 * Régressions constatées en conditions réelles le 2026-07-28, lors du premier
 * dépôt de bout en bout sur HyperBox2. Les deux étaient invisibles en test
 * unitaire mocké : elles ne se manifestent que contre un vrai PostgreSQL avec
 * le rôle applicatif de moindre privilège.
 */
describe("GED — régressions SQL constatées en production", () => {
  it("n'utilise jamais ON CONFLICT DO UPDATE sur ged_blobs", async () => {
    // `cerp_app` n'a que SELECT et INSERT sur ged_blobs : un DO UPDATE, même
    // sans effet, exige le privilège UPDATE et échoue en 42501.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../module/ged/repository/ged.repository.ts", import.meta.url), "utf8")
    );
    const blobInsert = source.slice(
      source.indexOf("INSERT INTO public.ged_blobs"),
      source.indexOf("INSERT INTO public.ged_blobs") + 400
    );
    expect(blobInsert).toContain("ON CONFLICT (sha256) DO NOTHING");
    expect(blobInsert).not.toContain("DO UPDATE");
  });

  it("ne combine jamais FOR UPDATE avec une fonction d'agrégat", async () => {
    // PostgreSQL refuse « FOR UPDATE is not allowed with aggregate functions ».
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../module/ged/repository/ged.repository.ts", import.meta.url), "utf8")
    );
    const codeQuery = source.slice(
      source.indexOf("async function nextDocumentCode"),
      source.indexOf("export async function repoCreateDocumentWithVersion")
    );
    expect(codeQuery).toContain("pg_advisory_xact_lock");
    expect(codeQuery).not.toMatch(/MAX\([\s\S]*FOR UPDATE/);
  });
});
