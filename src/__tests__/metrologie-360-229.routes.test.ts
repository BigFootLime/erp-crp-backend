// Surface HTTP Métrologie 360 (#229) : RBAC refusé par défaut, validation
// stricte, verrou optimiste obligatoire et non-fuite des chemins de stockage.

import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  currentRole: { value: "administrateur" as string | null },
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();
  const pool = {
    on: emitter.on.bind(emitter),
    query: mocks.poolQuery,
    connect: mocks.poolConnect,
  };
  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });
  return { Pool: vi.fn(() => pool), __emitter__: emitter };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: { user?: { id: number; username: string; email: string; role: string } },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void
  ) => {
    if (mocks.currentRole.value === null) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }
    req.user = {
      id: 1,
      username: "tester",
      email: "tester@example.test",
      role: mocks.currentRole.value,
    };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";

const BASE = "/api/v1/metrologie/v2";
const EQUIP_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();
  mocks.currentRole.value = "administrateur";

  mocks.poolQuery.mockResolvedValue({ rows: [] });
  mocks.clientQuery.mockResolvedValue({ rows: [] });
  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });
});

describe("#229 authentification", () => {
  it("refuse un appel non authentifié", async () => {
    mocks.currentRole.value = null;
    const res = await request(app).get(`${BASE}/center`);
    expect(res.status).toBe(401);
  });
});

describe("#229 command center — contrat des paramètres SQL", () => {
  it("n'envoie aucun paramètre aux requêtes sans placeholder", async () => {
    mocks.poolQuery.mockImplementation(async (sql: unknown, values?: unknown[]) => {
      const placeholders = [...String(sql).matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
      const expectedCount = placeholders.length > 0 ? Math.max(...placeholders) : 0;
      expect(values ?? []).toHaveLength(expectedCount);
      return { rows: [] };
    });

    const res = await request(app).get(`${BASE}/center?site=ATELIER&categorie_code=MICROMETRE&horizon_days=45`);

    expect(res.status).toBe(200);
    expect(mocks.poolQuery).toHaveBeenCalled();
  });
});

describe("#229 RBAC — refus par défaut", () => {
  const readRoutes: Array<[string, string]> = [
    ["get", `${BASE}/center`],
    ["get", `${BASE}/categories`],
    ["get", `${BASE}/units`],
    ["get", `${BASE}/equipements`],
    ["get", `${BASE}/executions`],
  ];

  it.each(readRoutes)("refuse %s %s à un rôle sans droit", async (method, url) => {
    mocks.currentRole.value = "commercial";
    const res = await (request(app) as unknown as Record<string, (u: string) => Promise<{ status: number; body: Record<string, unknown> }>>)[
      method
    ](url);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "METROLOGY_CAPABILITY_REQUIRED" });
  });

  it("autorise la lecture à l'atelier mais refuse la validation de verdict", async () => {
    mocks.currentRole.value = "operateur atelier";
    const read = await request(app).get(`${BASE}/units`);
    expect(read.status).toBe(200);

    const validate = await request(app)
      .post(`${BASE}/executions/${EQUIP_ID}/validate`)
      .send({});
    expect(validate.status).toBe(403);
    expect(validate.body).toMatchObject({ code: "METROLOGY_CAPABILITY_REQUIRED" });
  });

  it("refuse au métrologue la décision d'impact, réservée à la qualité", async () => {
    mocks.currentRole.value = "metrologue";
    const res = await request(app)
      .post(`${BASE}/impacts/${EQUIP_ID}/items/${CHILD_ID}/decision`)
      .send({ decision: "NO_IMPACT", reason: "Aucun impact." });
    expect(res.status).toBe(403);
  });

  it("refuse au magasin toute écriture sur le registre", async () => {
    mocks.currentRole.value = "magasinier";
    const res = await request(app).post(`${BASE}/equipements`).send({ designation: "X" });
    expect(res.status).toBe(403);
  });

  it("refuse la gestion des catégories hors qualité/métrologie/direction", async () => {
    mocks.currentRole.value = "methodes";
    const res = await request(app)
      .put(`${BASE}/categories`)
      .send({ code: "TEST", label: "Test" });
    expect(res.status).toBe(403);
  });
});

describe("#229 validation stricte", () => {
  it("refuse un code d'équipement envoyé par le client (alloué serveur)", async () => {
    const res = await request(app)
      .post(`${BASE}/equipements`)
      .send({ code: "MET-000042", designation: "Pied à coulisse", categorie_code: "PIED_A_COULISSE" });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "METROLOGY_VALIDATION_ERROR" });
  });

  it("refuse une plage sans unité", async () => {
    const res = await request(app).post(`${BASE}/equipements`).send({
      designation: "Micromètre",
      categorie_code: "MICROMETRE",
      plage_min: 0,
      plage_max: 25,
    });
    expect(res.status).toBe(422);
    expect(res.body?.details?.fields).toHaveProperty("unite");
  });

  it("refuse une borne haute inférieure à la borne basse", async () => {
    const res = await request(app).post(`${BASE}/equipements`).send({
      designation: "Micromètre",
      categorie_code: "MICROMETRE",
      unite: "mm",
      plage_min: 25,
      plage_max: 0,
    });
    expect(res.status).toBe(422);
    expect(res.body?.details?.fields).toHaveProperty("plage_max");
  });

  it("refuse une valeur non finie", async () => {
    const res = await request(app)
      .post(`${BASE}/equipements`)
      .send({
        designation: "Balance",
        categorie_code: "BALANCE",
        unite: "g",
        resolution: 1e12,
      });
    expect(res.status).toBe(422);
  });

  it("exige expected_updated_at pour toute modification", async () => {
    const res = await request(app)
      .patch(`${BASE}/equipements/${EQUIP_ID}`)
      .send({ designation: "Nouveau nom", categorie_code: "MICROMETRE" });
    expect(res.status).toBe(422);
    expect(res.body?.details?.fields).toHaveProperty("expected_updated_at");
  });

  it("exige un motif d'au moins 10 caractères pour une quarantaine", async () => {
    const res = await request(app)
      .post(`${BASE}/equipements/${EQUIP_ID}/quarantine`)
      .send({ expected_updated_at: "2026-07-26T09:00:00.000Z", reason: "cassé" });
    expect(res.status).toBe(422);
    expect(res.body?.details?.fields).toHaveProperty("reason");
  });

  it("exige une empreinte d'aperçu pour valider un verdict", async () => {
    const res = await request(app)
      .post(`${BASE}/executions/${EQUIP_ID}/validate`)
      .send({
        expected_updated_at: "2026-07-26T09:00:00.000Z",
        verdict: "CONFORME",
        decision: "REMISE_EN_SERVICE",
        decision_reason: "Étalonnage conforme sur toute la plage.",
      });
    expect(res.status).toBe(422);
    expect(res.body?.details?.fields).toHaveProperty("preview_hash");
  });

  it("exige une restriction quand le verdict est conforme avec restriction", async () => {
    const res = await request(app)
      .post(`${BASE}/executions/${EQUIP_ID}/validate`)
      .send({
        expected_updated_at: "2026-07-26T09:00:00.000Z",
        preview_hash: "a".repeat(64),
        verdict: "CONFORME_AVEC_RESTRICTION",
        decision: "REMISE_EN_SERVICE",
        decision_reason: "Emploi restreint au bas de plage.",
      });
    expect(res.status).toBe(422);
    expect(res.body?.details?.fields).toHaveProperty("restriction");
  });

  it("exige une approbation pour une échéance dérogatoire", async () => {
    const res = await request(app)
      .post(`${BASE}/executions/${EQUIP_ID}/validate`)
      .send({
        expected_updated_at: "2026-07-26T09:00:00.000Z",
        preview_hash: "a".repeat(64),
        verdict: "CONFORME",
        decision: "REMISE_EN_SERVICE",
        decision_reason: "Étalonnage conforme sur toute la plage.",
        override_next_due_date: "2028-01-01",
      });
    expect(res.status).toBe(422);
    expect(res.body?.details?.fields).toHaveProperty("override_approved_by");
  });

  it("exige un prestataire déclaré pour un étalonnage externe", async () => {
    const res = await request(app)
      .post(`${BASE}/equipements/${EQUIP_ID}/plans`)
      .send({
        operation_type: "ETALONNAGE",
        periodicite_valeur: 12,
        prestataire_type: "EXTERNE",
      });
    expect(res.status).toBe(422);
    expect(res.body?.details?.fields).toHaveProperty("prestataire_label");
  });

  it("exige une date d'effet pour une échéance à date fixe", async () => {
    const res = await request(app)
      .post(`${BASE}/equipements/${EQUIP_ID}/plans`)
      .send({
        operation_type: "VERIFICATION",
        periodicite_valeur: 6,
        base_calcul: "FIXED_DATE",
      });
    expect(res.status).toBe(422);
    expect(res.body?.details?.fields).toHaveProperty("effective_from");
  });

  it("exige une version de plan pour un étalonnage", async () => {
    const res = await request(app)
      .post(`${BASE}/equipements/${EQUIP_ID}/executions`)
      .send({ operation_type: "ETALONNAGE" });
    expect(res.status).toBe(422);
    expect(res.body?.details?.fields).toHaveProperty("plan_version_id");
  });

  it("exige les deux bornes et une justification pour une fenêtre d'impact imposée", async () => {
    const partial = await request(app)
      .post(`${BASE}/equipements/${EQUIP_ID}/impacts`)
      .send({ window_from: "2026-01-01T00:00:00.000Z" });
    expect(partial.status).toBe(422);
    expect(partial.body?.details?.fields).toHaveProperty("window_to");

    const unjustified = await request(app)
      .post(`${BASE}/equipements/${EQUIP_ID}/impacts`)
      .send({
        window_from: "2026-01-01T00:00:00.000Z",
        window_to: "2026-06-01T00:00:00.000Z",
        window_reason: "court",
      });
    expect(unjustified.status).toBe(422);
    expect(unjustified.body?.details?.fields).toHaveProperty("window_reason");
  });

  it("refuse « à traiter » comme décision d'impact", async () => {
    const res = await request(app)
      .post(`${BASE}/impacts/${EQUIP_ID}/items/${CHILD_ID}/decision`)
      .send({ decision: "PENDING", reason: "Sans avis pour l'instant." });
    expect(res.status).toBe(422);
  });

  it("refuse un identifiant qui n'est pas un UUID", async () => {
    const res = await request(app).get(`${BASE}/equipements/pas-un-uuid`);
    expect(res.status).toBe(422);
  });

  it("borne la pagination", async () => {
    const res = await request(app).get(`${BASE}/equipements?pageSize=5000`);
    expect(res.status).toBe(422);
  });

  it("refuse un segment inconnu du command center", async () => {
    const res = await request(app).get(`${BASE}/equipements?segment=inconnu`);
    expect(res.status).toBe(422);
  });

  it("refuse un paramètre de requête inconnu (schéma strict)", async () => {
    const res = await request(app).get(`${BASE}/equipements?sqlInjection=1`);
    expect(res.status).toBe(422);
  });
});

describe("#229 éligibilité", () => {
  it("exige l'instrument en mode single", async () => {
    const res = await request(app).get(`${BASE}/eligibility?mode=single`);
    expect(res.status).toBe(422);
    expect(res.body?.details?.fields).toHaveProperty("instrument_id");
  });

  it("évalue un instrument inconnu sans jamais tomber en 500", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    const res = await request(app).get(
      `${BASE}/eligibility?mode=single&instrument_id=${EQUIP_ID}&characteristic_key=COTE_A`
    );
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({
      eligible: false,
      reason_code: "INSTRUMENT_REQUIRED",
    });
  });
});

describe("#229 référentiel d'unités", () => {
  it("expose la liste serveur des unités supportées", async () => {
    const res = await request(app).get(`${BASE}/units`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.some((u: { canonical: string }) => u.canonical === "mm")).toBe(true);
  });
});

describe("#229 non-fuite du stockage", () => {
  it("ne renvoie jamais storage_path dans le détail d'un équipement", async () => {
    const now = "2026-07-26T09:00:00.000Z";
    mocks.poolQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.metrologie_equipements e") && sql.includes("cat.label AS categorie_label")) {
        return Promise.resolve({
          rows: [
            {
              id: EQUIP_ID,
              code: "MET-000001",
              designation: "Pied à coulisse",
              categorie_code: "PIED_A_COULISSE",
              categorie_label: "Pied à coulisse",
              sous_categorie_code: null,
              marque: null,
              modele: null,
              numero_serie: null,
              criticite: "NORMAL",
              etat: "QUALIFIED",
              etat_motif: null,
              etat_changed_at: null,
              statut: "ACTIF",
              proprietaire_service: null,
              site: null,
              magasin: null,
              zone: null,
              localisation_precise: null,
              date_mise_en_service: null,
              date_retrait: null,
              unite: "mm",
              plage_min: "0",
              plage_max: "150",
              resolution: "0.01",
              mpe: null,
              incertitude: null,
              methodes: [],
              conditions_utilisation: null,
              restrictions: null,
              etalon_reference: null,
              exige_certificat: false,
              specifications: {},
              quarantine_reason: null,
              quarantined_at: null,
              last_conforme_at: null,
              last_conforme_execution_id: null,
              notes: null,
              created_at: now,
              updated_at: now,
              responsable_id: null,
              responsable_username: null,
              responsable_name: null,
              responsable_surname: null,
              created_by_id: null,
              created_by_username: null,
              created_by_name: null,
              created_by_surname: null,
              updated_by_id: null,
              updated_by_username: null,
              updated_by_name: null,
              updated_by_surname: null,
            },
          ],
        });
      }
      if (sql.includes("FROM public.metrologie_certificats c")) {
        return Promise.resolve({
          rows: [
            {
              id: CHILD_ID,
              equipement_id: EQUIP_ID,
              execution_id: null,
              document_kind: "CERTIFICAT",
              date_etalonnage: "2026-01-15",
              date_echeance: "2027-01-15",
              resultat: "CONFORME",
              statut: "VALIDE",
              emetteur: "LNE",
              numero_externe: "LNE-2026-1",
              organisme: null,
              commentaire: null,
              confidentiality: "RESTRICTED",
              cancel_reason: null,
              cancelled_at: null,
              replaced_by_id: null,
              file_original_name: "certificat.pdf",
              mime_type: "application/pdf",
              size_bytes: "12345",
              sha256: "f".repeat(64),
              has_file: true,
              created_at: now,
              created_by_id: null,
              created_by_username: null,
              created_by_name: null,
              created_by_surname: null,
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app).get(`${BASE}/equipements/${EQUIP_ID}`);
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("storage_path");
    expect(serialized).not.toContain("/srv/");
    expect(res.body.certificats[0]).toMatchObject({ has_file: true, sha256: "f".repeat(64) });
    // Les capacités sont renvoyées par le serveur : l'UI n'invente aucun droit.
    expect(res.body.capabilities).toMatchObject({ read: true, equipment_release: true });
  });
});
