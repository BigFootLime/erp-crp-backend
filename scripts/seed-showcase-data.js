#!/usr/bin/env node
/* eslint-disable no-console */

// Offline synthetic dataset for the isolated CERP showcase database.
// It deliberately uses no HTTP server, routes, tokens or production database.

const { Client } = require("pg");

const DEMO_DATABASE = "cerp_demo";
const REQUIRED_TABLES = [
  "users", "clients", "adresse_facturation", "adresse_livraison", "informations_bancaires",
  "fournisseurs", "articles", "articles_matiere_families", "articles_matiere",
  "magasins", "emplacements", "warehouses", "locations", "units", "stock_levels",
  "machines", "postes", "pieces_families", "pieces_techniques", "piece_technique_versions",
  "devis", "devis_ligne",
];

const IDS = Object.freeze({
  materialArticle: "d01d0001-0000-4000-8000-000000000001",
  warehouse: "d01d0002-0000-4000-8000-000000000001",
  location: "d01d0003-0000-4000-8000-000000000001",
  machineMill: "d01d0004-0000-4000-8000-000000000001",
  machineTurn: "d01d0004-0000-4000-8000-000000000002",
  posteMill: "d01d0005-0000-4000-8000-000000000001",
  posteTurn: "d01d0005-0000-4000-8000-000000000002",
  pieceOne: "d01d0006-0000-4000-8000-000000000001",
  pieceTwo: "d01d0006-0000-4000-8000-000000000002",
  finishedArticleOne: "d01d0007-0000-4000-8000-000000000001",
  finishedArticleTwo: "d01d0007-0000-4000-8000-000000000002",
});

function fail(message) {
  throw new Error(`[showcase-seed] ${message}`);
}

function assertDemoEnvironment(environment = process.env) {
  if (environment.CERP_DEMO_MODE !== "true") fail("CERP_DEMO_MODE=true is required");
  const rawUrl = environment.DATABASE_URL;
  if (!rawUrl) fail("DATABASE_URL is required");
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail("DATABASE_URL is invalid");
  }
  if (parsed.pathname !== `/${DEMO_DATABASE}`) fail(`refusing database other than ${DEMO_DATABASE}`);
}

function demoUsername(environment = process.env) {
  const username = (environment.DEMO_SEED_USERNAME ?? "DEMO").trim().toUpperCase();
  if (!username) fail("DEMO_SEED_USERNAME must not be empty");
  return username;
}

async function runStage(name, operation) {
  try {
    return await operation();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    // Stage names make a remote seed failure actionable without logging a URL,
    // SQL parameter values, credentials, or any business data.
    fail(`stage ${name} failed: ${reason}`);
  }
}

async function assertSchema(client, username) {
  const { rows } = await client.query(
    "SELECT unnest($1::text[]) AS table_name, to_regclass('public.' || unnest($1::text[])) IS NOT NULL AS present",
    [REQUIRED_TABLES]
  );
  const missing = rows.filter((row) => !row.present).map((row) => row.table_name);
  if (missing.length) fail(`schema prerequisites missing: ${missing.join(", ")}`);

  const user = await client.query("SELECT id FROM public.users WHERE username = $1 LIMIT 1", [username]);
  if (!user.rowCount) fail(`demo account ${username} missing; run scripts/seed-demo-account.js first`);
  return user.rows[0].id;
}

async function ensureClient(client, index) {
  const code = `DEMO${String(index).padStart(2, "0")}`;
  const existing = await client.query("SELECT client_id FROM public.clients WHERE client_code = $1 LIMIT 1", [code]);
  if (existing.rowCount) return existing.rows[0].client_id;

  const company = `Atelier Démo ${index}`;
  const bill = await client.query(
    "INSERT INTO public.adresse_facturation (street, postal_code, city, country, name) VALUES ($1, $2, $3, $4, $5) RETURNING bill_address_id",
    [`${index} rue de la Démonstration`, "69000", "Lyon", "France", company]
  );
  const delivery = await client.query(
    "INSERT INTO public.adresse_livraison (street, postal_code, city, country, name) VALUES ($1, $2, $3, $4, $5) RETURNING delivery_address_id",
    [`${index} quai des Ateliers`, "69100", "Villeurbanne", "France", company]
  );
  const bank = await client.query(
    "INSERT INTO public.informations_bancaires (iban, bic, name) VALUES ($1, $2, $3) RETURNING bank_info_id",
    [`FR7612345678901234567890${index}`, `DEMOFRPP${String(index).padStart(3, "0")}`, "Banque Démo"]
  );
  const inserted = await client.query(
    `INSERT INTO public.clients (
       client_id, client_code, company_name, email, phone, website_url, siret, vat_number, naf_code,
       status, blocked, reason, creation_date, delivery_address_id, bill_address_id, bank_info_id,
       observations, provided_documents_id, quality_levels
     ) VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,NULL,'client',false,NULL,current_date,$7,$8,$9,$10,NULL,'{}')
     RETURNING client_id`,
    [`${900 + index}`, code, company, `contact.${index}@example.test`, "+33400000000", "https://example.test",
      delivery.rows[0].delivery_address_id, bill.rows[0].bill_address_id, bank.rows[0].bank_info_id,
      "Donnée synthétique de démonstration"]
  );
  return inserted.rows[0].client_id;
}

async function ensureSupplier(client) {
  const result = await client.query(
    `INSERT INTO public.fournisseurs (code_fournisseur, raison_sociale, code, nom, actif, email, telephone, site_web, notes)
     VALUES ('DEMO-FOUR-01','Fournitures Démo','DEMO-FOUR-01','Fournitures Démo',true,'fournisseur.demo@example.test','+33400000001','https://example.test','Donnée synthétique de démonstration')
     ON CONFLICT (code_fournisseur) DO UPDATE SET code = EXCLUDED.code, nom = EXCLUDED.nom, raison_sociale = EXCLUDED.raison_sociale, actif = EXCLUDED.actif, updated_at = now()
     RETURNING id`
  );
  return result.rows[0].id;
}

async function ensureStock(client, userId) {
  await client.query(
    "INSERT INTO public.articles_matiere_families (code, designation) VALUES ('DEMO','Matières démonstration') ON CONFLICT (code) DO NOTHING"
  );
  let article = await client.query("SELECT id FROM public.articles WHERE code = 'DEMO-MAT-01' LIMIT 1");
  if (!article.rowCount) {
    article = await client.query(
      `INSERT INTO public.articles (
         id, code, designation, article_type, article_category, family_code, unite, lot_tracking,
         stock_managed, is_active, notes, root_article_id, version_number, plan_index, status, created_by, updated_by
       ) VALUES ($1,'DEMO-MAT-01','Aluminium 6082 — démo','PURCHASED','matiere','DEMO','u',false,true,true,
         'Donnée synthétique de démonstration',$1,1,1,'VALIDE',$2,$2) RETURNING id`,
      [IDS.materialArticle, userId]
    );
  }
  const articleId = article.rows[0].id;
  await client.query(
    "INSERT INTO public.articles_matiere (article_id, family_code) VALUES ($1, 'DEMO') ON CONFLICT (article_id) DO UPDATE SET family_code = EXCLUDED.family_code, updated_at = now()",
    [articleId]
  );
  const magasin = await client.query(
    `INSERT INTO public.magasins (code_magasin, libelle, code, name, is_active, notes)
     VALUES ('DEMO-MAG','Magasin démonstration','DEMO-MAG','Magasin démonstration',true,'Donnée synthétique de démonstration')
     ON CONFLICT (code_magasin) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, libelle = EXCLUDED.libelle, is_active = true, updated_at = now()
     RETURNING id`
  );
  const magasinId = magasin.rows[0].id;
  let emplacement = await client.query("SELECT id FROM public.emplacements WHERE magasin_id = $1 AND code = 'DEMO-A01' LIMIT 1", [magasinId]);
  if (emplacement.rowCount) {
    await client.query("UPDATE public.emplacements SET name='Allée démonstration A01', is_active=true, updated_at=now() WHERE id=$1", [emplacement.rows[0].id]);
  } else {
    emplacement = await client.query(
      "INSERT INTO public.emplacements (magasin_id, code, name, is_scrap, is_active, notes) VALUES ($1,'DEMO-A01','Allée démonstration A01',false,true,'Donnée synthétique de démonstration') RETURNING id",
      [magasinId]
    );
  }
  let warehouse = await client.query("SELECT id FROM public.warehouses WHERE code = 'DEMO-MAG' LIMIT 1");
  if (!warehouse.rowCount) {
    warehouse = await client.query(
      "INSERT INTO public.warehouses (id, code, name) VALUES ($1, 'DEMO-MAG', 'Magasin démonstration') RETURNING id",
      [IDS.warehouse]
    );
  }
  let location = await client.query("SELECT id FROM public.locations WHERE warehouse_id = $1 AND code = 'DEMO-A01' LIMIT 1", [warehouse.rows[0].id]);
  if (!location.rowCount) {
    location = await client.query(
      "INSERT INTO public.locations (id, warehouse_id, code, description) VALUES ($1, $2, 'DEMO-A01', 'Allée démonstration A01') RETURNING id",
      [IDS.location, warehouse.rows[0].id]
    );
  }
  let unit = await client.query("SELECT id FROM public.units WHERE code = 'u' LIMIT 1");
  if (!unit.rowCount) unit = await client.query("INSERT INTO public.units (code, label) VALUES ('u', 'Unité') RETURNING id");
  const stock = await client.query(
    "SELECT id FROM public.stock_levels WHERE article_id = $1 AND warehouse_id = $2 AND location_id = $3 LIMIT 1",
    [articleId, warehouse.rows[0].id, location.rows[0].id]
  );
  if (stock.rowCount) {
    await client.query("UPDATE public.stock_levels SET qty_total = 240, qty_reserved = 0, qty_depreciated = 0, updated_at = now(), updated_by = $2 WHERE id = $1", [stock.rows[0].id, userId]);
  } else {
    await client.query(
      `INSERT INTO public.stock_levels (article_id, unit_id, warehouse_id, location_id, managed_in_stock, qty_total, qty_reserved, qty_depreciated, created_by, updated_by)
       VALUES ($1,$2,$3,$4,true,240,0,0,$5,$5)`,
      [articleId, unit.rows[0].id, warehouse.rows[0].id, location.rows[0].id, userId]
    );
  }
}

async function ensureMachineAndPostes(client, userId) {
  const machines = [
    [IDS.machineMill, "DEMO-CN-01", "Centre d'usinage Orion", "MILLING", "CN-01", "Usinage", "#4D7CFE"],
    [IDS.machineTurn, "DEMO-TN-02", "Tour numérique Atlas", "TURNING", "CN-02", "Usinage", "#38BDF8"],
  ];
  for (const [id, code, name, type, posteCode, zone, color] of machines) {
    const machine = await client.query(
      `INSERT INTO public.machines (
         id, code, name, display_name, type, brand, model, hourly_rate, status, is_available,
         workshop_zone, location, dashboard_color, notes, commissioned_year, created_by, updated_by
       ) VALUES ($1,$2,$3,$3,$4,'CERP Démo',$2,72.50,'ACTIVE',true,$5,'Atelier démonstration',$6,
         'Équipement synthétique pour la découverte CERP+',2022,$7,$7)
       ON CONFLICT (code) DO UPDATE SET
         name=EXCLUDED.name, display_name=EXCLUDED.display_name, status='ACTIVE', is_available=true,
         workshop_zone=EXCLUDED.workshop_zone, dashboard_color=EXCLUDED.dashboard_color,
         archived_at=NULL, updated_at=now(), updated_by=EXCLUDED.updated_by
       RETURNING id`,
      [id, code, name, type, zone, color, userId]
    );
    await client.query(
      `INSERT INTO public.postes (id, code, label, machine_id, hourly_rate_override, currency, is_active, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,72.50,'EUR',true,'Poste synthétique de démonstration',$5,$5)
       ON CONFLICT (code) DO UPDATE SET
         label=EXCLUDED.label, machine_id=EXCLUDED.machine_id, is_active=true, archived_at=NULL,
         updated_at=now(), updated_by=EXCLUDED.updated_by`,
      [posteCode === "CN-01" ? IDS.posteMill : IDS.posteTurn, posteCode, `Poste ${posteCode} — démonstration`, machine.rows[0].id, userId]
    );
  }
}

async function ensureTechnicalPiece(client, { id, finishedArticleId, code, designation, clientId, userId, price }) {
  await client.query(
    "INSERT INTO public.pieces_families (code, designation, type_famille) VALUES ('DEMO','Pièces de démonstration','USINAGE') ON CONFLICT (code) DO UPDATE SET designation=EXCLUDED.designation"
  );
  const family = await client.query("SELECT id FROM public.pieces_families WHERE code = 'DEMO' LIMIT 1");
  const piece = await client.query(
    `INSERT INTO public.pieces_techniques (
       id, root_piece_technique_id, version_number, client_id, created_by, updated_by, famille_id,
       name_piece, code_piece, designation, prix_unitaire, statut, en_fabrication, code_client,
       client_name, ensemble, quality_levels, piece_critique
     ) SELECT $1::uuid,$1::uuid,1,$2::varchar,$3::integer,$3::integer,$4::uuid,$5::text,$6::text,$5::text,$7::numeric,'ACTIVE',1,$2::text,c.company_name,false,ARRAY[]::text[],false
       FROM public.clients c WHERE c.client_id=$2::varchar
     ON CONFLICT (code_piece) DO UPDATE SET
       client_id=EXCLUDED.client_id, updated_by=EXCLUDED.updated_by, famille_id=EXCLUDED.famille_id,
       name_piece=EXCLUDED.name_piece, designation=EXCLUDED.designation, prix_unitaire=EXCLUDED.prix_unitaire,
       statut='ACTIVE', en_fabrication=1, deleted_at=NULL, updated_at=now()
     RETURNING id`,
    [id, clientId, userId, family.rows[0].id, designation, code, price]
  );
  const pieceId = piece.rows[0].id;
  let article = await client.query("SELECT id FROM public.articles WHERE code = $1 LIMIT 1", [`ART-${code}`]);
  if (!article.rowCount) {
    await client.query("INSERT INTO public.articles_fabrique_families (code, designation) VALUES ('DEMO-PF','Pièces finies de démonstration') ON CONFLICT (code) DO NOTHING");
    article = await client.query(
      `INSERT INTO public.articles (
         id, code, designation, article_type, piece_technique_id, unite, lot_tracking, is_active,
         article_category, stock_managed, family_code, root_article_id, version_number, plan_index,
         status, is_sold, created_by, updated_by
       ) VALUES ($1,$2,$3,'PIECE_TECHNIQUE',$4,'u',false,true,'fabrique',true,'DEMO-PF',$1,1,1,'VALIDE',true,$5,$5)
       RETURNING id`,
      [finishedArticleId, `ART-${code}`, designation, pieceId, userId]
    );
  }
  const articleId = article.rows[0].id;
  await client.query(
    "INSERT INTO public.articles_fabrique (article_id, family_code, piece_technique_id) VALUES ($1, 'DEMO-PF', $2) ON CONFLICT (article_id) DO UPDATE SET family_code=EXCLUDED.family_code, piece_technique_id=EXCLUDED.piece_technique_id, updated_at=now()",
    [articleId, pieceId]
  );
  await client.query("UPDATE public.pieces_techniques SET article_id=$2, updated_at=now(), updated_by=$3 WHERE id=$1", [pieceId, articleId, userId]);
  const version = await client.query("SELECT id FROM public.piece_technique_versions WHERE piece_technique_id=$1 AND indice='A' LIMIT 1", [pieceId]);
  if (version.rowCount) {
    await client.query("UPDATE public.piece_technique_versions SET plan_reference=$2, statut='BROUILLON', is_current=true, updated_at=now(), updated_by=$3 WHERE id=$1", [version.rows[0].id, `PLAN-${code}-A`, userId]);
  } else {
    await client.query(
      `INSERT INTO public.piece_technique_versions (
         piece_technique_id, indice, plan_reference, matiere_prevue, statut, is_current, date_revision,
         version_interne, code_metier, code_metier_normalise, created_by, updated_by, manufacturing_mode, assembly_supply_strategy
       ) VALUES ($1,'A',$2,'Aluminium 6082','BROUILLON',true,now(),1,$3,$3,$4,$4,'SIMPLE','MAKE_TO_ORDER')`,
      [pieceId, `PLAN-${code}-A`, `${code}-A`, userId]
    );
  }
  return { pieceId, articleId };
}

async function ensureQuote(client, { number, clientId, userId, articleId, pieceId, designation, quantity, price }) {
  let quote = await client.query("SELECT id FROM public.devis WHERE numero=$1 LIMIT 1", [number]);
  if (!quote.rowCount) {
    quote = await client.query(
      `WITH next_quote AS (SELECT nextval('public.devis_id_seq') AS id)
       INSERT INTO public.devis (
         id, numero, client_id, user_id, adresse_facturation_id, adresse_livraison_id,
         date_creation, date_validite, statut, total_ht, total_ttc, commentaires, root_devis_id, version_number
       ) SELECT id,$1,$2,$3,c.bill_address_id,c.delivery_address_id,current_timestamp,current_date + 30,
         'BROUILLON',$4,$5,'Devis synthétique de démonstration',id,1
         FROM next_quote JOIN public.clients c ON c.client_id=$2 RETURNING id`,
      [number, clientId, userId, quantity * price, quantity * price * 1.2]
    );
  }
  const quoteId = quote.rows[0].id;
  const line = await client.query("SELECT id FROM public.devis_ligne WHERE devis_id=$1 AND position=1 LIMIT 1", [quoteId]);
  if (line.rowCount) {
    await client.query(
      "UPDATE public.devis_ligne SET description=$2, quantite=$3, unite='unité', prix_unitaire_ht=$4, remise_ligne=0, taux_tva=20, article_id=$5, piece_technique_id=$6 WHERE id=$1",
      [line.rows[0].id, designation, quantity, price, articleId, pieceId]
    );
  } else {
    await client.query(
      "INSERT INTO public.devis_ligne (devis_id, description, quantite, unite, prix_unitaire_ht, remise_ligne, taux_tva, article_id, piece_technique_id, position) VALUES ($1,$2,$3,'unité',$4,0,20,$5,$6,1)",
      [quoteId, designation, quantity, price, articleId, pieceId]
    );
  }
  await client.query("UPDATE public.devis SET total_ht=$2, total_ttc=$3, statut='BROUILLON', updated_at=current_timestamp WHERE id=$1", [quoteId, quantity * price, quantity * price * 1.2]);
}

async function main() {
  assertDemoEnvironment();
  const username = demoUsername();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const userId = await runStage("schema", () => assertSchema(client, username));
    await client.query("BEGIN");
    const firstClientId = await runStage("client-1", () => ensureClient(client, 1));
    const secondClientId = await runStage("client-2", () => ensureClient(client, 2));
    await runStage("supplier", () => ensureSupplier(client));
    await runStage("stock", () => ensureStock(client, userId));
    await runStage("machines-postes", () => ensureMachineAndPostes(client, userId));
    const firstPiece = await runStage("technical-piece-1", () => ensureTechnicalPiece(client, {
      id: IDS.pieceOne,
      finishedArticleId: IDS.finishedArticleOne,
      code: "DEMO-PT-001",
      designation: "Support de guidage — démonstration",
      clientId: firstClientId,
      userId,
      price: 148.50,
    }));
    const secondPiece = await runStage("technical-piece-2", () => ensureTechnicalPiece(client, {
      id: IDS.pieceTwo,
      finishedArticleId: IDS.finishedArticleTwo,
      code: "DEMO-PT-002",
      designation: "Flasque de liaison — démonstration",
      clientId: secondClientId,
      userId,
      price: 96.00,
    }));
    await runStage("draft-quote-1", () => ensureQuote(client, {
      number: "DEV-DEMO-001",
      clientId: firstClientId,
      userId,
      articleId: firstPiece.articleId,
      pieceId: firstPiece.pieceId,
      designation: "Support de guidage — série découverte",
      quantity: 12,
      price: 148.50,
    }));
    await runStage("draft-quote-2", () => ensureQuote(client, {
      number: "DEV-DEMO-002",
      clientId: secondClientId,
      userId,
      articleId: secondPiece.articleId,
      pieceId: secondPiece.pieceId,
      designation: "Flasque de liaison — série découverte",
      quantity: 8,
      price: 96.00,
    }));
    await client.query("COMMIT");
    console.log("[showcase-seed] synthetic clients, stock, machines, technical parts and draft quotes ready");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "[showcase-seed] failed");
    process.exitCode = 1;
  });
}

module.exports = { assertDemoEnvironment, demoUsername, main, runStage, ensureMachineAndPostes, ensureTechnicalPiece, ensureQuote };
