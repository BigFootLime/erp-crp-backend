import { describe, expect, it } from "vitest";

import {
  executionProfileMatchesEquipment,
  findMetrologyEquipmentProfile,
  listMetrologyEquipmentProfiles,
  mergeMetrologySpecifications,
} from "../module/metrologie/domain/metrology-equipment-profiles";
import { generateMetrologyProfileEquipmentCode } from "../shared/codes/code-generator.service";
import {
  createEquipmentSchema,
  createExecutionSchema,
} from "../module/metrologie/validators/metrology-360.validators";
import { patchEquipementSchema } from "../module/metrologie/validators/metrologie.validators";
import { assertLegacyEquipmentCodeUnchanged } from "../module/metrologie/repository/metrologie.repository";

const equipment = {
  code: "PC-01",
  designation: "Pied à coulisse 150 mm",
  categorie_code: "PIED_A_COULISSE",
  specifications: { fiche_metrologie: { version: 1, profile_code: "PC", historique: { PRECIS: "0,02 mm" } } },
};

describe("profils MD15 de métrologie", () => {
  it("expose le profil PC sans fabriquer de cote ni de tolérance", () => {
    const profile = findMetrologyEquipmentProfile("pc");
    expect(profile?.code_prefix).toBe("PC");
    expect(profile?.min_next_number).toBe(59);
    expect(profile?.measurement_points).toHaveLength(8);
    expect(profile?.measurement_points.some((point) => point.kind === "DEPTH")).toBe(true);
    expect(profile?.measurement_points.every((point) => !("nominal" in point) && !("tolerance" in point))).toBe(true);
  });

  it("garde les familles historiques et leurs bornes de réservation distinctes", () => {
    const profiles = listMetrologyEquipmentProfiles();
    expect(profiles.map((profile) => profile.code)).toEqual(expect.arrayContaining(["PC", "JP", "ME", "MI", "TF", "TFD", "TLD"]));
    expect(findMetrologyEquipmentProfile("TFD")?.min_next_number).toBe(4);
    expect(new Set(profiles.map((profile) => profile.code_prefix)).size).toBe(profiles.length);
  });

  it("accepte la reprise d'un code et des champs historiques bornés", () => {
    const parsed = createEquipmentSchema.safeParse({ body: {
      ...equipment,
      specifications: { fiche_metrologie: { version: 1, profile_code: "PC", historique: { PRECIS: "0,02 mm", REBUT: "non", OBS: "Contrôle visuel." } } },
    } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.body.specifications.fiche_metrologie?.historique.REBUT).toBe(false);
  });

  it("préserve COCONTR daté comme texte historique sans le confondre avec un code alloué", () => {
    const parsed = createEquipmentSchema.safeParse({ body: {
      code: "TFD-03",
      designation: "Tampon fileté double",
      categorie_code: "CALIBRE",
      specifications: { fiche_metrologie: { version: 1, profile_code: "TFD", historique: { COCONTR: "CA-03-09/2013" } } },
    } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.body.specifications.fiche_metrologie?.historique.COCONTR).toBe("CA-03-09/2013");
  });

  it("alloue automatiquement quand le frontend transmet un code nul", () => {
    expect(createEquipmentSchema.safeParse({ body: { ...equipment, code: null } }).success).toBe(true);
  });

  it.each(["PC-00", "PC-0001"])("refuse les alias de code non canoniques (%s)", (code) => {
    expect(createEquipmentSchema.safeParse({ body: { ...equipment, code } }).success).toBe(false);
  });

  it("refuse un profil/catégorie incohérent dès la création", () => {
    expect(createEquipmentSchema.safeParse({ body: { ...equipment, categorie_code: "MICROMETRE" } }).success).toBe(false);
  });

  it("accepte le code legacy inchangé sous verrou mais refuse son renommage", () => {
    const parsed = patchEquipementSchema.safeParse({ body: { patch: { code: "PC-01", designation: "Pied" } } });
    expect(parsed.success).toBe(true);
    expect(() => assertLegacyEquipmentCodeUnchanged("PC-01", parsed.success ? parsed.data.body.patch.code : undefined)).not.toThrow();
    expect(() => assertLegacyEquipmentCodeUnchanged("PC-01", "PC-02")).toThrow(/immuable/i);
  });

  it("préserve les métadonnées historiques supplémentaires sans les qualifier", () => {
    const parsed = createEquipmentSchema.safeParse({ body: {
      ...equipment,
      specifications: { fiche_metrologie: { version: 1, profile_code: "PC", historique: { INCONNU: "x" } } },
    } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.body.specifications.fiche_metrologie?.historique.INCONNU).toBe("x");
  });

  it("conserve les cellules absentes comme inconnues et refuse les types invalides des champs connus", () => {
    const historique = {
      IDCONTROLE: null, COCONTR: "PC-01", DESA1: null, MARQU: null, NUMSERIE: "0000",
      PRECIS: null, PERIOD: null, DATEENTR: null, DATEDERN: null, REBUT: null,
      ETREF: null, MIREF: null, MAREF: null, APMI: null, APMA: null, OBS: null,
      CODEEMP: null, COSERVICE: null, DATESO: null, TYPEP_RIODE: null,
    };
    const parse = (values: Record<string, unknown>) => createEquipmentSchema.safeParse({ body: {
      ...equipment, specifications: { fiche_metrologie: { version: 1, profile_code: "PC", historique: values } },
    } });
    const accepted = parse(historique);
    expect(accepted.success).toBe(true);
    if (accepted.success) expect(accepted.data.body.specifications.fiche_metrologie?.historique).toEqual(historique);
    expect(parse({ ...historique, NUMSERIE: 0 }).success).toBe(false);
    expect(parse({ ...historique, REBUT: "peut-être" }).success).toBe(false);
    expect(parse({ ...historique, DATEDERN: "2026-02-31" }).success).toBe(false);
  });

  it("enregistre le visa MD15 comme contexte d'exécution sans verdict", () => {
    const parsed = createExecutionSchema.safeParse({
      params: { id: "11111111-1111-4111-8111-111111111111" },
      body: {
        operation_type: "VERIFICATION",
        plan_version_id: "22222222-2222-4222-8222-222222222222",
        environnement: { fiche_metrologie: { version: 1, profile_code: "PC", visa: "AB", etat_mecanique: "RAS", entretien: null } },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("conserve les métadonnées de fiche sur un PATCH qui ne les mentionne pas", () => {
    const merged = mergeMetrologySpecifications(
      { fiche_metrologie: { version: 1, profile_code: "PC" }, legacy: "conservé" },
      { another_key: true }
    );
    expect(merged).toMatchObject({ fiche_metrologie: { profile_code: "PC" }, legacy: "conservé", another_key: true });
  });

  it("refuse de rapprocher une exécution d'un profil différent de sa fiche instrument", () => {
    expect(executionProfileMatchesEquipment("PC", "JP")).toBe(false);
    expect(executionProfileMatchesEquipment("PC", "PC")).toBe(true);
    expect(executionProfileMatchesEquipment("PC", null)).toBe(true);
  });

  it("alloue PC-59 puis PC-60 sans collision lorsque deux créations concurrentes partent du plancher historique", async () => {
    let sequence = 58;
    const tx = {
      query: async (sql: string) => {
        if (sql.includes("fn_next_issued_code_value")) return { rows: [{ v: String(++sequence) }] };
        if (sql.includes("SELECT EXISTS")) return { rows: [{ exists: false }] };
        throw new Error(`Requête de test inattendue: ${sql}`);
      },
    };
    await expect(Promise.all([
      generateMetrologyProfileEquipmentCode(tx, { prefix: "PC", minNextNumber: 59 }),
      generateMetrologyProfileEquipmentCode(tx, { prefix: "PC", minNextNumber: 59 }),
    ])).resolves.toEqual(["PC-59", "PC-60"]);
  });
});
