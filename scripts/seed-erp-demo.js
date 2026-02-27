#!/usr/bin/env node
/* eslint-disable no-console */

// Demo data seeding script.
// - Starts the API on an ephemeral port (no need to run `npm run dev`)
// - Seeds demo entities via the REST API (so validation + business rules run)
// - Idempotent-ish via stable DEMO codes (skips if already present)
//
// Usage:
//   npm run build
//   node scripts/seed-erp-demo.js
//
// Optional env:
//   DATABASE_URL=postgres://...
//   JWT_SECRET=...
//   SEED_TAG=demo

process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/erp-database";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "seed-demo-secret";

const http = require("http");
const crypto = require("crypto");

const jwt = require("jsonwebtoken");
const { Client } = require("pg");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function asJson(res) {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await res.json();
  return await res.text();
}

async function httpJson(base, method, urlPath, headers, body) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { ...headers, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data = await asJson(res);
  if (!res.ok) {
    const msg = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`${method} ${urlPath} -> ${res.status}: ${msg}`);
  }
  return data;
}

async function httpMultipart(base, urlPath, headers, dataObj, files) {
  const form = new FormData();
  form.set("data", JSON.stringify(dataObj));

  for (const f of files ?? []) {
    // Undici FormData supports Blob/File.
    const blob = new Blob([f.content], { type: f.mimeType });
    form.append("documents[]", blob, f.filename);
  }

  const res = await fetch(`${base}${urlPath}`, {
    method: "POST",
    headers,
    body: form,
  });

  const out = await asJson(res);
  if (!res.ok) {
    const msg = typeof out === "string" ? out : JSON.stringify(out);
    throw new Error(`POST ${urlPath} (multipart) -> ${res.status}: ${msg}`);
  }
  return out;
}

async function ensureSeedUser(pg) {
  const users = (
    await pg.query("SELECT id::int AS id, username, email, role FROM public.users ORDER BY id ASC LIMIT 1")
  ).rows;

  if (users.length > 0) return users[0];

  const suf = crypto.randomUUID().slice(0, 8);
  return (
    await pg.query(
      `
        INSERT INTO public.users (
          username,
          password,
          name,
          surname,
          email,
          tel_no,
          role,
          gender,
          address,
          lane,
          house_no,
          postcode,
          date_of_birth,
          social_security_number
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        RETURNING id::int AS id, username, email, role
      `,
      [
        `seed-${suf}`,
        "seed",
        "Seed",
        "User",
        `seed-${suf}@example.test`,
        "+33600000000",
        "Directeur",
        "Male",
        "Seed Street",
        "Lane",
        "1",
        "69000",
        "1990-01-01",
        `SEED-${suf}`,
      ]
    )
  ).rows[0];
}

async function main() {
  const seedTag = (process.env.SEED_TAG ?? "demo").trim() || "demo";

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  // Lazy-load server modules only after env is set.
  const appMod = require("../dist/config/app");
  const app = appMod.default ?? appMod;
  const sockMod = require("../dist/sockets/sockeServer");
  const initSocketServer = sockMod.initSocketServer;

  const server = http.createServer(app);
  initSocketServer(server);

  await new Promise((resolve, reject) =>
    server.listen(0, "127.0.0.1", (e) => (e ? reject(e) : resolve()))
  );

  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const user = await ensureSeedUser(pg);
    assert(user && typeof user.id === "number", "Missing seed user");

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username ?? "seed",
        email: user.email ?? "seed@example.test",
        role: user.role ?? "Directeur",
      },
      process.env.JWT_SECRET,
      { expiresIn: "2h" }
    );

    const authHeaders = { Authorization: `Bearer ${token}`, "X-Page-Key": "seed" };

    // Ensure stock reference data exists (units + currencies). Some databases are missing this patch.
    await pg.query(
      "INSERT INTO public.currencies (code, name) VALUES ('EUR','Euro') ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name"
    );
    await pg.query(
      "INSERT INTO public.units (code, label) VALUES ('u','Unite') ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label"
    );

    console.log(`[seed] base=${base}`);
    console.log(`[seed] db=${process.env.DATABASE_URL}`);
    console.log(`[seed] tag=${seedTag}`);

    const upperTag = seedTag.toUpperCase();

    const pickItems = (out) =>
      out?.items ?? out?.data?.items ?? out?.rows ?? out?.data?.rows ?? out?.data ?? out;

    // ---------- Pieces families (needed for pieces techniques)
    const familiesExisting = await httpJson(base, "GET", "/api/v1/pieces-families", {}, undefined);
    const wantFamilyCodes = [`${upperTag}-FAM-01`, `${upperTag}-FAM-02`];
    const familyByCode = new Map(
      (Array.isArray(familiesExisting) ? familiesExisting : []).map((f) => [f.code, f])
    );

    for (let i = 0; i < wantFamilyCodes.length; i++) {
      const code = wantFamilyCodes[i];
      if (familyByCode.has(code)) continue;

      const created = await httpJson(base, "POST", "/api/v1/pieces-families", {}, {
        code,
        designation: `Famille ${upperTag} ${String(i + 1).padStart(2, "0")}`,
        type_famille: i === 0 ? "USINAGE" : "OUTILLAGE",
        section: "DEMO",
      });
      familyByCode.set(created.code, created);
    }
    const families = wantFamilyCodes.map((c) => familyByCode.get(c)).filter(Boolean);
    assert(families.length >= 1, "Missing pieces family");

    // ---------- Stock: create one warehouse + a couple of locations
    const magasins = await httpJson(base, "GET", "/api/v1/stock/magasins?pageSize=200", authHeaders, undefined);
    const magasinItems = pickItems(magasins);
    const magasinCode = `${upperTag}-MAG-01`;
    let magasin = (Array.isArray(magasinItems) ? magasinItems : []).find((m) => m.code === magasinCode);
    if (!magasin) {
      magasin = await httpJson(base, "POST", "/api/v1/stock/magasins", authHeaders, {
        code: magasinCode,
        name: `Magasin ${upperTag} (demo)`,
        is_active: true,
        notes: "Magasin de demonstration",
      });
    }
    assert(magasin && typeof magasin.id === "string", "Missing magasin.id");

    const emplacementsOut = await httpJson(base, "GET", "/api/v1/stock/emplacements?pageSize=200", authHeaders, undefined);
    const emplacementItems = pickItems(emplacementsOut);

    async function ensureEmplacement(code, isScrap) {
      const existing = (Array.isArray(emplacementItems) ? emplacementItems : []).find(
        (e) => e.code === code && e.magasin_id === magasin.id
      );
      if (existing) return existing;
      const created = await httpJson(
        base,
        "POST",
        `/api/v1/stock/magasins/${magasin.id}/emplacements`,
        authHeaders,
        { code, name: code, is_scrap: !!isScrap, is_active: true }
      );
      return created;
    }

    const emplacementMain = await ensureEmplacement(`${upperTag}-A1`, false);
    const emplacementScrap = await ensureEmplacement(`${upperTag}-SCRAP`, true);
    assert(typeof emplacementMain.id === "number", "Expected emplacement.id as number");
    assert(typeof emplacementScrap.id === "number", "Expected emplacement.id as number");

    // Some DBs lack triggers for emplacement -> location mapping.
    async function ensureEmplacementLocation(emplacement) {
      const cur = (
        await pg.query(
          "SELECT location_id::text AS location_id FROM public.emplacements WHERE id = $1::bigint",
          [emplacement.id]
        )
      ).rows[0]?.location_id;
      if (cur) return cur;

      const warehouseCode = magasin.code;
      const warehouseName = magasin.name;

      let warehouseId = (
        await pg.query("SELECT id::text AS id FROM public.warehouses WHERE code = $1::citext LIMIT 1", [warehouseCode])
      ).rows[0]?.id;
      if (!warehouseId) {
        try {
          warehouseId = (
            await pg.query(
              "INSERT INTO public.warehouses (code, name) VALUES ($1::citext,$2) RETURNING id::text AS id",
              [warehouseCode, warehouseName]
            )
          ).rows[0]?.id;
        } catch {
          warehouseId = (
            await pg.query("SELECT id::text AS id FROM public.warehouses WHERE code = $1::citext LIMIT 1", [warehouseCode])
          ).rows[0]?.id;
        }
      }

      assert(warehouseId, "Missing warehouse for emplacement mapping");

      const locationCode = `${warehouseCode}-${emplacement.code}`;
      let locationId = (
        await pg.query(
          "SELECT id::text AS id FROM public.locations WHERE warehouse_id = $1::uuid AND code = $2::citext LIMIT 1",
          [warehouseId, locationCode]
        )
      ).rows[0]?.id;
      if (!locationId) {
        try {
          locationId = (
            await pg.query(
              "INSERT INTO public.locations (warehouse_id, code, description) VALUES ($1::uuid,$2::citext,$3) RETURNING id::text AS id",
              [warehouseId, locationCode, `Emplacement ${emplacement.code}`]
            )
          ).rows[0]?.id;
        } catch {
          locationId = (
            await pg.query(
              "SELECT id::text AS id FROM public.locations WHERE warehouse_id = $1::uuid AND code = $2::citext LIMIT 1",
              [warehouseId, locationCode]
            )
          ).rows[0]?.id;
        }
      }

      assert(locationId, "Missing location for emplacement mapping");

      await pg.query(
        "UPDATE public.emplacements SET location_id = $2::uuid WHERE id = $1::bigint",
        [emplacement.id, locationId]
      );

      return locationId;
    }

    await ensureEmplacementLocation(emplacementMain);
    await ensureEmplacementLocation(emplacementScrap);

    // ---------- Fournisseurs (and a small catalogue)
    const fournisseursOut = await httpJson(base, "GET", "/api/v1/fournisseurs?pageSize=200", authHeaders, undefined);
    const fournisseurs = pickItems(fournisseursOut) ?? [];
    const fournisseurByCode = new Map(
      (Array.isArray(fournisseurs) ? fournisseurs : []).map((f) => [String(f.code ?? "").trim(), f])
    );

    const fournisseurIds = [];
    for (let i = 1; i <= 5; i++) {
      const code = `${upperTag}-FR-${String(i).padStart(3, "0")}`;
      let fr = fournisseurByCode.get(code);
      if (!fr) {
        fr = await httpJson(base, "POST", "/api/v1/fournisseurs", authHeaders, {
          code,
          nom: `Fournisseur ${upperTag} ${i}`,
          actif: true,
          email: `fournisseur.${seedTag}.${i}@example.test`,
          telephone: "+33 4 00 00 00 0" + i,
          site_web: "https://example.test",
          notes: "Fournisseur de demonstration",
        });
      }
      if (fr && fr.id) fournisseurIds.push(fr.id);
    }

    // ---------- Clients
    const demoClientPrefix = `Client ${upperTag} `;
    const demoClients = (
      await pg.query(
        "SELECT client_id, company_name FROM public.clients WHERE company_name ILIKE $1 ORDER BY client_id ASC",
        [`${demoClientPrefix}%`]
      )
    ).rows;

    const clientIds = demoClients.map((c) => c.client_id).filter(Boolean);

    const today = new Date();
    const isoDate = today.toISOString().slice(0, 10);

    for (let i = clientIds.length + 1; i <= 5; i++) {
      const company_name = `${demoClientPrefix}${i}`;
      const created = await httpJson(base, "POST", "/api/v1/clients", authHeaders, {
        company_name,
        email: `client.${seedTag}.${i}@example.test`,
        phone: "+33 4 00 00 00 1" + i,
        website_url: "https://example.test",
        siret: "",
        vat_number: "",
        naf_code: "",
        status: i <= 2 ? "prospect" : "client",
        blocked: false,
        reason: "",
        creation_date: isoDate,
        payment_mode_ids: [],
        bank: {
          bank_name: "BANQUE DEMO",
          iban: "FR7612345678901234567890123",
          bic: "DEMOFRPP",
        },
        observations: "Client de demonstration",
        provided_documents_id: "",
        bill_address: {
          name: company_name,
          street: "1 rue de la Demo",
          house_number: "",
          postal_code: "69000",
          city: "Lyon",
          country: "France",
        },
        delivery_address: {
          name: `${company_name} (Livraison)`,
          street: "10 avenue du Test",
          house_number: "",
          postal_code: "69100",
          city: "Villeurbanne",
          country: "France",
        },
        primary_contact: {
          first_name: "Camille",
          last_name: `Client${i}`,
          email: `contact.${seedTag}.${i}@example.test`,
          phone_personal: "+33 6 00 00 00 2" + i,
          role: "Achats",
          civility: "Mme",
        },
        contacts: [],
        quality_level: "",
        quality_levels: [],
      });
      if (created && created.client_id) clientIds.push(created.client_id);
    }
    assert(clientIds.length >= 5, "Expected 5 clients");

    // ---------- Devis + Affaires (1 each)
    const devisIds = [];
    const affaireIds = [];
    for (let i = 1; i <= 5; i++) {
      const client_id = clientIds[i - 1];
      const numero = `${upperTag}-DV-${today.getFullYear()}-${String(i).padStart(3, "0")}`;

      let devisId;
      try {
        const existing = await httpJson(
          base,
          "GET",
          `/api/v1/devis?q=${encodeURIComponent(numero)}&pageSize=10`,
          {},
          undefined
        );
        const items = pickItems(existing);
        const match = (Array.isArray(items) ? items : []).find((d) => String(d.numero ?? "").trim() === numero);
        if (match && typeof match.id === "number") devisId = match.id;
      } catch {
        // ignore lookup errors
      }

      if (typeof devisId !== "number") {
        // Create devis (multipart) with at least one line.
        const devis = await httpMultipart(
          base,
          "/api/v1/devis",
          {},
          {
            numero,
            client_id,
            user_id: user.id,
            date_creation: isoDate,
            date_validite: isoDate,
            statut: "BROUILLON",
            remise_globale: 0,
            lignes: [
              {
                description: `Usinage piece ${upperTag} ${i}`,
                quantite: 10,
                unite: "u",
                prix_unitaire_ht: 25 + i,
                remise_ligne: 0,
                taux_tva: 20,
              },
              {
                description: `Controle qualite ${upperTag} ${i}`,
                quantite: 1,
                unite: "forfait",
                prix_unitaire_ht: 80,
                remise_ligne: 0,
                taux_tva: 20,
              },
            ],
            commentaires: "Devis de demonstration",
          },
          [
            {
              filename: `${numero}.txt`,
              mimeType: "text/plain",
              content: `Devis demo ${numero}\nClient: ${client_id}\n`,
            },
          ]
        );

        devisId = devis?.devis?.id ?? devis?.id;
      }

      if (typeof devisId === "number") devisIds.push(devisId);

      const reference = `${upperTag}-AF-${String(i).padStart(3, "0")}`;

      let affaireId;
      try {
        const existing = await httpJson(
          base,
          "GET",
          `/api/v1/affaires?q=${encodeURIComponent(reference)}&pageSize=10&include=client`,
          {},
          undefined
        );
        const items = pickItems(existing);
        const match = (Array.isArray(items) ? items : []).find(
          (a) => String(a.reference ?? a?.affaire?.reference ?? "").trim() === reference
        );
        affaireId = match?.id ?? match?.affaire_id ?? match?.affaire?.id;
      } catch {
        // ignore lookup errors
      }

      if (typeof affaireId !== "number") {
        try {
          const affaire = await httpJson(base, "POST", "/api/v1/affaires", {}, {
            reference,
            client_id,
            devis_id: typeof devisId === "number" ? devisId : null,
            type_affaire: "fabrication",
            statut: "OUVERTE",
            date_ouverture: isoDate,
            commentaire: "Affaire de demonstration",
          });
          affaireId = affaire?.affaire?.id ?? affaire?.id ?? affaire?.affaire_id;
        } catch {
          // likely already exists (409) -> resolve below
          const existing = await httpJson(
            base,
            "GET",
            `/api/v1/affaires?q=${encodeURIComponent(reference)}&pageSize=10&include=client`,
            {},
            undefined
          );
          const items = pickItems(existing);
          const match = (Array.isArray(items) ? items : []).find(
            (a) => String(a.reference ?? a?.affaire?.reference ?? "").trim() === reference
          );
          affaireId = match?.id ?? match?.affaire_id ?? match?.affaire?.id;
        }
      }

      if (typeof affaireId === "number") affaireIds.push(affaireId);
    }
    assert(devisIds.length >= 5, "Expected 5 devis ids");
    assert(affaireIds.length >= 5, "Expected 5 affaire ids");

    // ---------- Pieces techniques (+ link to affaires)
    const createdPieceIds = [];

    const existingPieces = await httpJson(
      base,
      "GET",
      `/api/v1/pieces-techniques?q=${encodeURIComponent(upperTag + "-PT-")}&pageSize=200`,
      authHeaders,
      undefined
    );
    const existingPieceItems = pickItems(existingPieces);
    const existingPieceByCode = new Map(
      (Array.isArray(existingPieceItems) ? existingPieceItems : []).map((p) => [p.code_piece, p])
    );

    for (let i = 1; i <= 5; i++) {
      const code_piece = `${upperTag}-PT-${String(i).padStart(3, "0")}`;
      const designation = `Piece technique ${upperTag} ${i}`;
      const famille = families[(i - 1) % families.length];
      const client_id = clientIds[(i - 1) % clientIds.length];

      let pieceId = existingPieceByCode.get(code_piece)?.id;

      if (typeof pieceId !== "string") {
        const piece = await httpJson(base, "POST", "/api/v1/pieces-techniques", authHeaders, {
          client_id,
          code_client: `REF-${upperTag}-${String(i).padStart(3, "0")}`,
          client_name: null,
          famille_id: famille.id,
          name_piece: designation,
          code_piece,
          designation,
          designation_2: null,
          prix_unitaire: 120 + i * 10,
          statut: i <= 3 ? "ACTIVE" : "DRAFT",
          cycle: 35,
          cycle_fabrication: 40,
          ensemble: false,
          bom: [],
          operations: [
            { phase: 10, designation: "Debit", prix: 5, coef: 1, tp: 5, tf_unit: 0, qte: 1, taux_horaire: 60 },
            { phase: 20, designation: "Usinage", prix: 10, coef: 1, tp: 10, tf_unit: 0, qte: 1, taux_horaire: 75 },
            { phase: 30, designation: "Controle", prix: 3, coef: 1, tp: 3, tf_unit: 0, qte: 1, taux_horaire: 65 },
          ],
          achats: [],
        });
        pieceId = piece?.piece?.id ?? piece?.id;
      }

      assert(typeof pieceId === "string", `Expected piece technique id (uuid) for ${code_piece}`);
      createdPieceIds.push(pieceId);

      // Link the piece to an affaire.
      const affaireId = affaireIds[(i - 1) % affaireIds.length];
      try {
        await httpJson(base, "POST", `/api/v1/pieces-techniques/${pieceId}/affaires`, authHeaders, {
          affaire_id: affaireId,
          role: "MAIN",
        });
      } catch {
        // likely already linked
      }
    }

    // ---------- Production: machines + postes
    const machinesOut = await httpJson(base, "GET", "/api/v1/production/machines?pageSize=200", authHeaders, undefined);
    const machineItems = pickItems(machinesOut) ?? [];
    const machineByCode = new Map((Array.isArray(machineItems) ? machineItems : []).map((m) => [m.code, m]));

    const machineIds = [];
    for (let i = 1; i <= 5; i++) {
      const code = `${upperTag}-M-${String(i).padStart(3, "0")}`;
      let m = machineByCode.get(code);
      if (!m) {
        m = await httpJson(base, "POST", "/api/v1/production/machines", authHeaders, {
          code,
          name: `Machine ${upperTag} ${i}`,
          type: i % 2 === 0 ? "TURNING" : "MILLING",
          brand: "DEMO",
          model: `Model-${i}`,
          serial_number: `SN-${seedTag.toUpperCase()}-${i}`,
          hourly_rate: 85,
          currency: "EUR",
          status: "ACTIVE",
          is_available: true,
          location: "Atelier",
          workshop_zone: "Zone A",
          notes: "Machine de demonstration",
        });
      }
      if (m && m.id) machineIds.push(m.id);
    }

    const postesOut = await httpJson(base, "GET", "/api/v1/production/postes?pageSize=200", authHeaders, undefined);
    const posteItems = pickItems(postesOut) ?? [];
    const posteByCode = new Map((Array.isArray(posteItems) ? posteItems : []).map((p) => [p.code, p]));

    for (let i = 1; i <= 3; i++) {
      const code = `${upperTag}-P-${String(i).padStart(3, "0")}`;
      if (posteByCode.has(code)) continue;
      await httpJson(base, "POST", "/api/v1/production/postes", authHeaders, {
        code,
        label: `Poste ${upperTag} ${i}`,
        machine_id: machineIds[(i - 1) % machineIds.length] ?? null,
        hourly_rate_override: null,
        currency: "EUR",
        is_active: true,
        notes: "Poste de demonstration",
      });
    }

    // ---------- Stock articles (+ lots + movements)
    const createdArticleIds = [];

    async function ensureArticle(code, payload) {
      try {
        const existing = await httpJson(
          base,
          "GET",
          `/api/v1/stock/articles?q=${encodeURIComponent(code)}&pageSize=10`,
          authHeaders,
          undefined
        );
        const items = pickItems(existing);
        const match = (Array.isArray(items) ? items : []).find((a) => String(a.code ?? "").trim() === code);
        if (match && typeof match.id === "string") return match;
      } catch {
        // ignore lookup errors
      }
      return await httpJson(base, "POST", "/api/v1/stock/articles", authHeaders, payload);
    }

    for (let i = 1; i <= 5; i++) {
      const code = `${upperTag}-ART-${String(i).padStart(3, "0")}`;
      const art = await ensureArticle(code, {
        code,
        designation: `Matiere / Consommable ${upperTag} ${i}`,
        article_type: "PURCHASED",
        unite: "u",
        lot_tracking: true,
        is_active: true,
        notes: "Article achete (demo)",
      });
      const artId = art?.article?.id ?? art?.id;
      if (typeof artId === "string") createdArticleIds.push(artId);
    }

    for (let i = 1; i <= 5; i++) {
      const code = `${upperTag}-PT-ART-${String(i).padStart(3, "0")}`;
      const ptId = createdPieceIds[(i - 1) % createdPieceIds.length];
      const art = await ensureArticle(code, {
        code,
        designation: `Article piece technique ${upperTag} ${i}`,
        article_type: "PIECE_TECHNIQUE",
        piece_technique_id: ptId,
        unite: "u",
        lot_tracking: false,
        is_active: true,
        notes: "Article lie a une piece technique (demo)",
      });
      const artId = art?.article?.id ?? art?.id;
      if (typeof artId === "string") createdArticleIds.push(artId);
    }

    // Create lots + IN movements for purchased articles.
    for (let i = 1; i <= 5; i++) {
      const articleId = createdArticleIds[i - 1];
      if (!articleId) continue;

      const lotCode = `${upperTag}-LOT-${String(i).padStart(3, "0")}`;

      let lotId;
      try {
        const existingLots = await httpJson(
          base,
          "GET",
          `/api/v1/stock/lots?q=${encodeURIComponent(lotCode)}&article_id=${encodeURIComponent(articleId)}&pageSize=10`,
          authHeaders,
          undefined
        );
        const items = pickItems(existingLots);
        const match = (Array.isArray(items) ? items : []).find(
          (l) => String(l.lot_code ?? "").trim() === lotCode && String(l.article_id ?? "").trim() === articleId
        );
        lotId = match?.id;
      } catch {
        // ignore lookup errors
      }

      if (typeof lotId !== "string") {
        try {
          const lot = await httpJson(base, "POST", "/api/v1/stock/lots", authHeaders, {
            article_id: articleId,
            lot_code: lotCode,
            supplier_lot_code: null,
            received_at: isoDate,
            manufactured_at: null,
            expiry_at: null,
            notes: "Lot de demonstration",
          });
          lotId = lot?.lot?.id ?? lot?.id;
        } catch {
          const existingLots = await httpJson(
            base,
            "GET",
            `/api/v1/stock/lots?q=${encodeURIComponent(lotCode)}&article_id=${encodeURIComponent(articleId)}&pageSize=10`,
            authHeaders,
            undefined
          );
          const items = pickItems(existingLots);
          const match = (Array.isArray(items) ? items : []).find(
            (l) => String(l.lot_code ?? "").trim() === lotCode && String(l.article_id ?? "").trim() === articleId
          );
          lotId = match?.id;
        }
      }

      const movement = await httpJson(base, "POST", "/api/v1/stock/movements", authHeaders, {
        movement_type: "IN",
        effective_at: isoDate,
        source_document_type: "SEED",
        source_document_id: `${upperTag}-${i}`,
        reason_code: "DEMO",
        notes: "Entree stock demo",
        idempotency_key: `${upperTag}-IN-${i}`,
        lines: [
          {
            line_no: 1,
            article_id: articleId,
            lot_id: typeof lotId === "string" ? lotId : null,
            qty: 100 + i * 10,
            unite: "u",
            unit_cost: 1.5 + i * 0.2,
            currency: "EUR",
            dst_magasin_id: magasin.id,
            dst_emplacement_id: emplacementMain.id,
            note: "Reception demo",
          },
        ],
      });

      const movementId = movement?.movement?.id ?? movement?.id;
      if (typeof movementId === "string") {
        await httpJson(base, "POST", `/api/v1/stock/movements/${movementId}/post`, authHeaders, undefined);
      }
    }

    // ---------- Fournisseur catalogue items (linking to articles)
    for (let i = 0; i < fournisseurIds.length; i++) {
      const fid = fournisseurIds[i];
      const articleId = createdArticleIds[i % createdArticleIds.length];
      if (!fid || !articleId) continue;

      await httpJson(base, "POST", `/api/v1/fournisseurs/${fid}/catalogue`, authHeaders, {
        type: i % 2 === 0 ? "MATIERE" : "CONSOMMABLE",
        article_id: articleId,
        designation: `Catalogue ${upperTag} ${i + 1}`,
        reference_fournisseur: `REF-${upperTag}-${String(i + 1).padStart(3, "0")}`,
        unite: "u",
        prix_unitaire: 2.5 + i,
        devise: "EUR",
        delai_jours: 14,
        moq: 10,
        conditions: "DAP",
        actif: true,
      });

      await httpJson(base, "POST", `/api/v1/fournisseurs/${fid}/contacts`, authHeaders, {
        nom: `Contact fournisseur ${seedTag.toUpperCase()} ${i + 1}`,
        email: `contact.fournisseur.${seedTag}.${i + 1}@example.test`,
        telephone: "+33 6 00 00 10 0" + (i + 1),
        role: "Commercial",
        notes: "Contact de demonstration",
        actif: true,
      });
    }

    console.log("[seed] done");
    console.log(`  clients: ${clientIds.length}`);
    console.log(`  devis: ${devisIds.length}`);
    console.log(`  affaires: ${affaireIds.length}`);
    console.log(`  fournisseurs: ${fournisseurIds.length}`);
    console.log(`  pieces techniques: ${createdPieceIds.length}`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await pg.end();
  }
}

main().catch((err) => {
  console.error("[seed] failed", err);
  process.exitCode = 1;
});
