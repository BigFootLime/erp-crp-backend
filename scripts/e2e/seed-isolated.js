#!/usr/bin/env node

const { Client } = require("pg");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const PASSWORD_HASH = "$2b$10$M6.b9HVIHwTCt3xOYQ9uJeIFFOSM5tkLY8m9pfHCUiMZDu9Fqilfe";
const FINANCE_ISSUER_ID = "b7c1e5a2-3f4d-4e8b-9a06-380569012000";
const FINANCE_YEAR = new Date().getUTCFullYear();
const REFERENCE_PERIOD_START = `${FINANCE_YEAR}-01-01`;
const STOCK_VALUATION_POLICY = {
  method: "WEIGHTED_AVERAGE",
  definition: "Coût moyen pondéré recalculé à chaque entrée valorisée dans la fixture isolée SOL-06.",
  unit: "METHOD",
  period_start: REFERENCE_PERIOD_START,
  period_end: null,
  source: "Fixture déterministe SOL-06 — aucune donnée de production",
  freshness_at: `${FINANCE_YEAR}-01-01T00:00:00.000Z`,
  reliability: "VERIFIED",
};
const DELIVERY_QUALITY_RULES = {
  aggregate_scope: "ALL_DELIVERY_ALLOCATIONS",
  derogation_mode: "FORBIDDEN",
  engine: "CERP_QUALITY_ELIGIBILITY_V1",
  required_documents: [],
  schema: "cerp.quality.delivery-release-policy.v1",
};
const DELIVERY_QUALITY_RULES_SHA256 = crypto
  .createHash("sha256")
  .update(JSON.stringify(DELIVERY_QUALITY_RULES))
  .digest("hex");
const USERS = [
  ["KEENAN", "Keenan", "E2E", "keenan.e2e@invalid.example", "Administrateur Systeme et Reseau", true, "Administrateur Systeme et Reseau"],
  ["E2E_STANDARD", "Standard", "E2E", "standard.e2e@invalid.example", "Employee", false, "Employee"],
  ["E2E_SALES", "Commerce", "E2E", "sales.e2e@invalid.example", "Secretaire", false, "Commerce"],
  ["E2E_PLANNER", "Planning", "E2E", "planner.e2e@invalid.example", "Responsable Programmation", false, "Planification"],
  ["E2E_OPERATOR", "Operateur", "E2E", "operator.e2e@invalid.example", "Employee", false, "Opérateur atelier"],
  ["E2E_QUALITY", "Qualite", "E2E", "quality.e2e@invalid.example", "Responsable Qualité", false, "Qualité"],
  ["E2E_PURCHASING", "Achats", "E2E", "purchasing.e2e@invalid.example", "Directeur", false, "Achats"],
  ["E2E_ACCOUNTANT", "Comptabilite", "E2E", "accounting.e2e@invalid.example", "Directeur", false, "RH-Financier"],
];

const SOL20_PLAN_CONTENT = Buffer.from(
  "%PDF-1.4\n% CERP SOL-20 isolated technical plan fixture\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n",
  "utf8"
);
const SOL20_TECHNICAL_SNAPSHOT = {
  schema_version: 1,
  piece_technique_id: "21000000-0000-4000-8000-000000000001",
  piece_technique_version_id: "23000000-0000-4000-8000-000000000001",
  indice: "A",
  source: "Fixture isolée SOL-20",
};
const SOL20_TECHNICAL_SNAPSHOT_JSON = JSON.stringify(SOL20_TECHNICAL_SNAPSHOT);
const SOL20_TECHNICAL_SNAPSHOT_SHA256 = crypto
  .createHash("sha256")
  .update(SOL20_TECHNICAL_SNAPSHOT_JSON)
  .digest("hex");

async function ensureIsolatedGedBlob(storageKey, content) {
  const root = process.env.CERP_GED_VAULT_ROOT;
  if (!root) throw new Error("CERP_GED_VAULT_ROOT is required for the isolated SOL-20 GED fixture");
  const target = path.resolve(root, storageKey);
  const resolvedRoot = path.resolve(root);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("SOL-20 GED fixture escaped its isolated root");
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const existing = await fs.readFile(target).catch(() => null);
  if (existing) {
    if (!existing.equals(content)) throw new Error("SOL-20 GED fixture hash path contains different content");
    return;
  }
  await fs.writeFile(target, content, { flag: "wx", mode: 0o600 });
}

function assertIsolated() {
  if (process.env.CERP_E2E_ISOLATED !== "1") throw new Error("CERP_E2E_ISOLATED=1 is required");
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname) || url.pathname !== "/cerp_test") {
    throw new Error("SOL-05 seed refuses non-loopback or non-cerp_test databases");
  }
}

async function main() {
  assertIsolated();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    // The access-review browser proof must always start from the same state.
    // The migration rehearsal also runs this seed against historical schemas,
    // before SOL-25 created these tables, so the reset is capability-based.
    const accessReviewTables = await client.query(
      `SELECT
         to_regclass('public.app_access_review_items') IS NOT NULL AS items,
         to_regclass('public.app_access_reviews') IS NOT NULL AS reviews`
    );
    if (accessReviewTables.rows[0]?.items && accessReviewTables.rows[0]?.reviews) {
      await client.query("DELETE FROM public.app_access_review_items");
      await client.query("DELETE FROM public.app_access_reviews");
    }
    for (const [username, name, surname, email, role, superadmin, assignedRole] of USERS) {
      const result = await client.query(
        `INSERT INTO public.users (username,password,name,surname,email,role,status,is_superadmin)
         VALUES ($1,$2,$3,$4,$5,$6,'Active',$7)
         ON CONFLICT (username) DO UPDATE SET
           password=EXCLUDED.password,name=EXCLUDED.name,surname=EXCLUDED.surname,
           email=EXCLUDED.email,role=EXCLUDED.role,status='Active',is_superadmin=EXCLUDED.is_superadmin
         RETURNING id`,
        [username, PASSWORD_HASH, name, surname, email, role, superadmin]
      );
      const userId = result.rows[0].id;
      for (const roleKey of new Set([role, assignedRole])) {
        await client.query(
          `INSERT INTO public.user_role_assignments (user_id,role_key,assigned_by)
           VALUES ($1,$2,(SELECT id FROM public.users WHERE username='KEENAN'))
           ON CONFLICT (user_id,role_key) DO NOTHING`,
          [userId, roleKey]
        );
      }
      if (!superadmin) {
        await client.query(
          `INSERT INTO public.app_module_user_access (user_id,module_key,access,updated_by)
           VALUES ($1,'administration','DENIED',(SELECT id FROM public.users WHERE username='KEENAN'))
           ON CONFLICT (user_id,module_key) DO UPDATE SET access='DENIED',updated_by=EXCLUDED.updated_by,updated_at=now()`,
          [userId]
        );
      }
    }

    await client.query(
      `INSERT INTO public.erp_settings (key,value_text,value_json,created_by,updated_by)
       VALUES (
         'stock.valuation_method',$1,$2::jsonb,
         (SELECT id FROM public.users WHERE username='KEENAN'),
         (SELECT id FROM public.users WHERE username='KEENAN')
       )
       ON CONFLICT (key) DO UPDATE SET
         value_text=EXCLUDED.value_text,value_json=EXCLUDED.value_json,
         updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [STOCK_VALUATION_POLICY.method, JSON.stringify(STOCK_VALUATION_POLICY)]
    );
    const readinessColumns = await client.query(
      `SELECT count(*)::int AS count
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='erp_settings'
         AND column_name = ANY (ARRAY[
           'definition','unit','period_start','period_end','source','freshness_at','reliability'
         ])`
    );
    if (readinessColumns.rows[0]?.count === 7) {
      await client.query(
        `UPDATE public.erp_settings SET
           definition=$1,unit=$2,period_start=$3::date,period_end=$4::date,
           source=$5,freshness_at=$6::timestamptz,reliability=$7,updated_at=now()
         WHERE key='stock.valuation_method'`,
        [
          STOCK_VALUATION_POLICY.definition,
          STOCK_VALUATION_POLICY.unit,
          STOCK_VALUATION_POLICY.period_start,
          STOCK_VALUATION_POLICY.period_end,
          STOCK_VALUATION_POLICY.source,
          STOCK_VALUATION_POLICY.freshness_at,
          STOCK_VALUATION_POLICY.reliability,
        ]
      );
    }

    await client.query(
      `INSERT INTO public.programmation_calendars (
         id,code,label,timezone,working_days,day_start,day_end,active,created_by,updated_by
       ) VALUES (
         '31000000-0000-4000-8000-000000000001','SOL06-E2E','Calendrier industriel isolé SOL-06',
         'Europe/Paris',ARRAY[1,2,3,4,5]::smallint[],'06:00','22:00',true,
         (SELECT id FROM public.users WHERE username='KEENAN'),
         (SELECT id FROM public.users WHERE username='KEENAN')
       ) ON CONFLICT (id) DO UPDATE SET
         label=EXCLUDED.label,timezone=EXCLUDED.timezone,working_days=EXCLUDED.working_days,
         day_start=EXCLUDED.day_start,day_end=EXCLUDED.day_end,active=true,updated_by=EXCLUDED.updated_by`
    );
    await client.query(
      `INSERT INTO public.centres_frais (
         id,code,name,statut,devise,commentaire,created_by,updated_by
       ) VALUES (
         '32000000-0000-4000-8000-000000000001','SOL06-CF-E2E','Centre de frais isolé SOL-06',
         'ACTIF','EUR','Fixture déterministe, sans valeur de production',
         (SELECT id FROM public.users WHERE username='KEENAN'),
         (SELECT id FROM public.users WHERE username='KEENAN')
       ) ON CONFLICT (id) DO UPDATE SET
         code=EXCLUDED.code,name=EXCLUDED.name,statut='ACTIF',devise='EUR',archived_at=NULL,
         commentaire=EXCLUDED.commentaire,updated_by=EXCLUDED.updated_by`
    );
    await client.query(
      `INSERT INTO public.production_cost_center_rates (
         id,cf_id,taux_horaire,devise,date_effet,date_fin,source,commentaire,created_by
       ) VALUES (
         '33000000-0000-4000-8000-000000000001','32000000-0000-4000-8000-000000000001',
         50,'EUR',$1::date,NULL,'Fixture déterministe SOL-06',
         'Valeur de test uniquement, jamais présentée comme donnée réelle',
         (SELECT id FROM public.users WHERE username='KEENAN')
       ) ON CONFLICT (id) DO UPDATE SET
         taux_horaire=EXCLUDED.taux_horaire,devise='EUR',date_effet=EXCLUDED.date_effet,
         date_fin=NULL,source=EXCLUDED.source,commentaire=EXCLUDED.commentaire`,
      [REFERENCE_PERIOD_START]
    );

    await client.query(
      `INSERT INTO public.clients (client_id,client_code,company_name,status,document_policy)
       VALUES ('901','E2E-CLIENT-901','Client preuve SOL-05','client','NONE')
       ON CONFLICT (client_id) DO UPDATE SET company_name=EXCLUDED.company_name,status='client'`
    );
    await client.query(
      `INSERT INTO public.adresse_livraison (
         delivery_address_id,name,street,postal_code,city,country
       ) VALUES (
         '91000000-0000-4000-8000-000000000001','Client preuve SOL-05','1 rue E2E','69001','Lyon','France'
       ) ON CONFLICT (delivery_address_id) DO UPDATE SET
         name=EXCLUDED.name,street=EXCLUDED.street,postal_code=EXCLUDED.postal_code,
         city=EXCLUDED.city,country=EXCLUDED.country`
    );
    await client.query(
      `INSERT INTO public.adresse_facturation (
         bill_address_id,name,street,postal_code,city,country
       ) VALUES (
         '92000000-0000-4000-8000-000000000001','Client preuve SOL-05','1 rue E2E','69001','Lyon','France'
       ) ON CONFLICT (bill_address_id) DO UPDATE SET
         name=EXCLUDED.name,street=EXCLUDED.street,postal_code=EXCLUDED.postal_code,
         city=EXCLUDED.city,country=EXCLUDED.country`
    );
    await client.query(
      `INSERT INTO public.contacts (
         contact_id,client_id,first_name,last_name,civility,role,phone_direct,email
       ) VALUES (
         '93000000-0000-4000-8000-000000000001','901','Contact','E2E','M.','Achats','0102030405','contact.e2e@invalid.example'
       ) ON CONFLICT (contact_id) DO UPDATE SET
         client_id='901',first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,
         role=EXCLUDED.role,phone_direct=EXCLUDED.phone_direct,email=EXCLUDED.email,archived_at=NULL`
    );
    await client.query(
      `UPDATE public.clients SET
         email='client.e2e@invalid.example',phone='0102030405',
         siren='123456789',
         electronic_address_scheme='0002',
         electronic_address_value='123456789',
         electronic_address_directory_entry_id='E2E-DIRECTORY-BUYER-123456789',
         electronic_address_verified_at='2026-08-27T00:00:00.000Z'::timestamptz,
         delivery_address_id='91000000-0000-4000-8000-000000000001',
         bill_address_id='92000000-0000-4000-8000-000000000001',
         contact_id='93000000-0000-4000-8000-000000000001'
       WHERE client_id='901'`
    );
    await client.query(
      `UPDATE public.finance_legal_mentions SET
         electronic_address_scheme='0002',
         electronic_address_value='380569012',
         electronic_address_directory_entry_id='E2E-DIRECTORY-SELLER-380569012',
         electronic_address_verified_at='2026-08-27T00:00:00.000Z'::timestamptz
       WHERE biller_id=$1::uuid
         AND effective_from <= $2::date
         AND (effective_to IS NULL OR effective_to > $2::date)`,
      [FINANCE_ISSUER_ID, REFERENCE_PERIOD_START]
    );
    await client.query(
      `INSERT INTO public.fournisseurs (id,code,nom,actif,status)
       VALUES ('50000000-0000-4000-8000-000000000001','E2E-FOURN-001','Fournisseur preuve SOL-05',true,'actif')
       ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code,nom=EXCLUDED.nom,actif=true,status='actif'`
    );
    await client.query(
      `INSERT INTO public.locations (id,warehouse_id,code,description)
       SELECT '10000000-0000-4000-8000-000000000001',id,'E2E-RECEPTION','Emplacement reception SOL-05'
       FROM public.warehouses WHERE code='NEW-MP'
       ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code,description=EXCLUDED.description`
    );
    await client.query(
      `INSERT INTO public.magasins (
         id,code,name,is_active,code_magasin,libelle,actif,warehouse_id,stock_scope
       ) SELECT
         '25000000-0000-4000-8000-000000000001','E2E-MP','Magasin reception SOL-05',true,
         'E2E-MP','Magasin reception SOL-05',true,w.id,'NEW'
       FROM public.warehouses w WHERE w.code='NEW-MP'
       ON CONFLICT (id) DO UPDATE SET
         code=EXCLUDED.code,name=EXCLUDED.name,is_active=true,code_magasin=EXCLUDED.code_magasin,
         libelle=EXCLUDED.libelle,actif=true,warehouse_id=EXCLUDED.warehouse_id,stock_scope='NEW'`
    );
    await client.query(
      `INSERT INTO public.emplacements (id,magasin_id,code,name,is_active,location_id,location_type,allow_inbound,allow_outbound)
       SELECT 900001,m.id,'E2E-RECEPTION','Emplacement reception SOL-05',true,
              '10000000-0000-4000-8000-000000000001','RECEIVING',true,true
       FROM public.magasins m WHERE m.id='25000000-0000-4000-8000-000000000001'
       ON CONFLICT (id) DO UPDATE SET
         magasin_id=EXCLUDED.magasin_id,code=EXCLUDED.code,name=EXCLUDED.name,
         is_active=true,location_id=EXCLUDED.location_id,allow_inbound=true,allow_outbound=true`
    );
    await client.query(
      `INSERT INTO public.articles (
         id,code,designation,article_type,unite,lot_tracking,is_active,article_category,
         stock_managed,family_code,root_article_id,version_number,plan_index,status,is_sold,row_version
       ) VALUES (
         '20000000-0000-4000-8000-000000000001','E2E-MP-001','Matiere preuve SOL-05',
         'PURCHASED','kg',true,true,'matiere',true,'matiere_premiere',
         '20000000-0000-4000-8000-000000000001',1,1,'VALIDE',true,1
       ) ON CONFLICT (id) DO UPDATE SET designation=EXCLUDED.designation,status='VALIDE',is_active=true`
    );
    await client.query(
      `INSERT INTO public.stock_levels (
         id,article_id,unit_id,warehouse_id,location_id,managed_in_stock,qty_total,qty_reserved,qty_depreciated
       ) SELECT
         '30000000-0000-4000-8000-000000000001',
         '20000000-0000-4000-8000-000000000001',u.id,w.id,l.id,true,20,0,0
       FROM public.units u
       JOIN public.warehouses w ON w.code='NEW-MP'
       JOIN public.locations l ON l.id='10000000-0000-4000-8000-000000000001'
       WHERE u.code='kg'
       ON CONFLICT (id) DO UPDATE SET qty_total=20,qty_reserved=0,qty_depreciated=0`
    );
    await client.query(
      `INSERT INTO public.stock_batches (id,stock_level_id,batch_code,qty_total,qty_reserved,qty_depreciated)
       VALUES ('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','E2E-LOT-001',20,0,0)
       ON CONFLICT (id) DO UPDATE SET qty_total=20,qty_reserved=0,qty_depreciated=0`
    );
    await client.query(
      `INSERT INTO public.pieces_techniques (
         id,client_id,name_piece,code_piece,designation,statut,en_fabrication,
         root_piece_technique_id,version_number,piece_critique
       ) VALUES (
         '21000000-0000-4000-8000-000000000001','901','Piece preuve SOL-05','E2E-PT-001',
         'Piece fabriquee preuve SOL-05','ACTIVE',true,
         '21000000-0000-4000-8000-000000000001',1,false
       ) ON CONFLICT (id) DO UPDATE SET
         client_id='901',name_piece=EXCLUDED.name_piece,code_piece=EXCLUDED.code_piece,
         designation=EXCLUDED.designation,statut='ACTIVE',en_fabrication=true,deleted_at=NULL`
    );
    await client.query(
      `INSERT INTO public.pieces_techniques (
         id,client_id,name_piece,code_piece,designation,statut,en_fabrication,
         root_piece_technique_id,version_number,piece_critique,article_id
       ) VALUES (
         '21000000-0000-4000-8000-000000000002','901','Piece article neuf SOL-05','E2E-PT-ARTICLE-NEW',
         'Article neuf preuve SOL-05','ACTIVE',true,
         '21000000-0000-4000-8000-000000000002',1,false,NULL
       ) ON CONFLICT (id) DO UPDATE SET
         client_id='901',name_piece=EXCLUDED.name_piece,code_piece=EXCLUDED.code_piece,
         designation=EXCLUDED.designation,statut='ACTIVE',en_fabrication=true,
         article_id=NULL,deleted_at=NULL`
    );
    await client.query(
      `INSERT INTO public.articles_fabrique_families (code,designation,is_active)
       VALUES
         ('piece_finie','Piece finie E2E',true),
         ('PT','Piece technique E2E',true)
       ON CONFLICT (code) DO UPDATE SET designation=EXCLUDED.designation,is_active=true`
    );
    await client.query(
      `INSERT INTO public.articles (
         id,code,designation,article_type,piece_technique_id,unite,lot_tracking,is_active,
         article_category,stock_managed,family_code,root_article_id,version_number,plan_index,
         status,is_sold,row_version
       ) VALUES (
         '22000000-0000-4000-8000-000000000001','E2E-PF-001','Piece fabriquee preuve SOL-05',
         'PIECE_TECHNIQUE','21000000-0000-4000-8000-000000000001','u',true,true,
         'fabrique',true,'piece_finie','22000000-0000-4000-8000-000000000001',1,1,
         'VALIDE',true,1
       ) ON CONFLICT (id) DO UPDATE SET
         designation=EXCLUDED.designation,piece_technique_id=EXCLUDED.piece_technique_id,
         status='VALIDE',is_active=true`
    );
    await client.query(
      `INSERT INTO public.articles_fabrique (article_id,family_code,piece_technique_id)
       VALUES ('22000000-0000-4000-8000-000000000001','piece_finie','21000000-0000-4000-8000-000000000001')
       ON CONFLICT (article_id) DO UPDATE SET
         family_code=EXCLUDED.family_code,piece_technique_id=EXCLUDED.piece_technique_id`
    );
    await client.query(
      `UPDATE public.pieces_techniques
       SET article_id='22000000-0000-4000-8000-000000000001'
       WHERE id='21000000-0000-4000-8000-000000000001'`
    );
    await client.query(
      `INSERT INTO public.piece_technique_versions (
         id,piece_technique_id,indice,plan_reference,matiere_prevue,statut,is_current,date_revision,date_validation,
         date_application,version_interne,code_metier,code_metier_normalise,
         document_requirements_frozen_at,document_requirements_policy
       ) VALUES (
         '23000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001',
         'A','E2E-PLAN-SOL20-A','42CrMo4','APPLICABLE',true,now(),now(),CURRENT_DATE,1,'E2E-PT-001-A','E2E-PT-001-A',now(),'NONE'
       ) ON CONFLICT (id) DO NOTHING`
    );
    await client.query(
      `INSERT INTO public.piece_technique_versions (
         id,piece_technique_id,indice,plan_reference,statut,is_current,date_revision,date_validation,
         date_application,version_interne,code_metier,code_metier_normalise,
         document_requirements_frozen_at,document_requirements_policy
       ) VALUES (
         '23000000-0000-4000-8000-000000000002','21000000-0000-4000-8000-000000000002',
         'A','E2E-PLAN-ARTICLE-NEW','APPLICABLE',true,now(),now(),CURRENT_DATE,1,
         'E2E-PT-ARTICLE-NEW-A','E2E-PT-ARTICLE-NEW-A',now(),'NONE'
       ) ON CONFLICT (id) DO UPDATE SET
         plan_reference=EXCLUDED.plan_reference,statut='APPLICABLE',is_current=true,date_validation=EXCLUDED.date_validation,
         date_application=EXCLUDED.date_application`
    );
    // This applicable routing is a baseline production prerequisite, not a
    // SOL-20-only document fixture.  Keeping it outside the optional SOL-20
    // block lets the migration rehearsal seed a realistic pre-SOL-06 copy.
    await client.query(
      `INSERT INTO public.gammes (
         id,piece_technique_version_id,code,designation,statut,is_current,created_by,updated_by
       ) VALUES (
         '92000000-0000-4000-8000-000000000003','23000000-0000-4000-8000-000000000001',
         'E2E-GAMME-SOL20','Gamme applicable preuve SOL-20','APPLICABLE',true,
         (SELECT id FROM public.users WHERE username='KEENAN'),
         (SELECT id FROM public.users WHERE username='KEENAN')
       ) ON CONFLICT (id) DO NOTHING`
    );

    const sol20Available = await client.query(
      `SELECT to_regclass('public.outillage_allocations') IS NOT NULL AS available`
    );
    if (sol20Available.rows[0].available) {
      await client.query(
        `INSERT INTO public.piece_technique_versions (
           id,piece_technique_id,indice,plan_reference,matiere_prevue,statut,is_current,
           date_revision,date_validation,date_application,version_interne,code_metier,
           code_metier_normalise,document_requirements_frozen_at,document_requirements_policy
         ) VALUES (
           '92000000-0000-4000-8000-000000000009','21000000-0000-4000-8000-000000000001',
           'Z','E2E-PLAN-OBSOLETE','42CrMo4','OBSOLETE',false,now(),now(),CURRENT_DATE,99,
           'E2E-PT-001-Z','E2E-PT-001-Z',now(),'NONE'
         ) ON CONFLICT (id) DO NOTHING`
      );
      await client.query(
        `INSERT INTO public.gestion_outils_famille (id_famille,nom_famille,ordre)
         VALUES (920001,'Fraises E2E SOL-20',1)
         ON CONFLICT (id_famille) DO UPDATE SET nom_famille=EXCLUDED.nom_famille,ordre=EXCLUDED.ordre`
      );
      await client.query(
        `INSERT INTO public.gestion_outils_geometrie (id_geometrie,id_famille,nom_geometrie,ordre)
         VALUES (920001,920001,'Fraise carbure SOL-20',1)
         ON CONFLICT (id_geometrie) DO UPDATE SET
           id_famille=EXCLUDED.id_famille,nom_geometrie=EXCLUDED.nom_geometrie,ordre=EXCLUDED.ordre`
      );
      await client.query(
        `INSERT INTO public.gestion_outils_outil (
           id_outil,designation,id_famille,id_geometrie,reference_fabricant,designation_outil_cnc,codification
         ) VALUES (
           920001,'Fraise carbure preuve SOL-20',920001,920001,'SOL20-REF-001','Fraise carbure preuve SOL-20','SOL20-OUT-001'
         ) ON CONFLICT (id_outil) DO UPDATE SET
           designation=EXCLUDED.designation,id_famille=EXCLUDED.id_famille,id_geometrie=EXCLUDED.id_geometrie,
           reference_fabricant=EXCLUDED.reference_fabricant,
           designation_outil_cnc=EXCLUDED.designation_outil_cnc,codification=EXCLUDED.codification`
      );
      await client.query(
        `INSERT INTO public.gestion_outils_stock (id_outil,quantite,quantite_minimale,date_maj)
         VALUES (920001,5,1,now())
         ON CONFLICT (id_outil) DO UPDATE SET quantite=5,quantite_minimale=1,date_maj=now()`
      );
      await client.query(
        `INSERT INTO public.outillage_tool_parameter_versions (
           id,id_outil,effective_from,unit_cost,expected_life_pieces,currency,source,
           source_observed_at,reliability,change_reason,created_by
         ) VALUES (
           '92000000-0000-4000-8000-000000000001',920001,'2026-01-01T00:00:00Z',25,500,'EUR',
           'Fixture isolée SOL-20 — fiche fabricant validée','2026-01-01T00:00:00Z','VERIFIED',
           'Paramètres de preuve E2E',(SELECT id FROM public.users WHERE username='KEENAN')
         ) ON CONFLICT (id) DO NOTHING`
      );
      await client.query(
        `INSERT INTO public.piece_version_tool_requirements (
           id,piece_technique_version_id,id_outil,required_quantity,usage_notes,created_by,updated_by
         ) VALUES (
           '92000000-0000-4000-8000-000000000002','23000000-0000-4000-8000-000000000001',
           920001,2,'Finition de la pièce E2E',(SELECT id FROM public.users WHERE username='KEENAN'),
           (SELECT id FROM public.users WHERE username='KEENAN')
         ) ON CONFLICT (piece_technique_version_id,id_outil) DO NOTHING`
      );
      await client.query(
        `INSERT INTO public.piece_version_tool_requirements (
           id,piece_technique_version_id,id_outil,required_quantity,usage_notes,created_by,updated_by
         ) VALUES (
           '92000000-0000-4000-8000-000000000010','92000000-0000-4000-8000-000000000009',
           920001,1,'Indice obsolète de preuve',(SELECT id FROM public.users WHERE username='KEENAN'),
           (SELECT id FROM public.users WHERE username='KEENAN')
         ) ON CONFLICT (piece_technique_version_id,id_outil) DO NOTHING`
      );
      await client.query(
        `INSERT INTO public.ordres_fabrication (
           id,numero,piece_technique_id,piece_technique_version_id,quantite_lancee,quantite_bonne,
           statut,technical_snapshot,technical_snapshot_sha256,technical_snapshot_at,created_by,updated_by
         ) VALUES (
           920001,'OF-E2E-SOL20','21000000-0000-4000-8000-000000000001',
           '23000000-0000-4000-8000-000000000001',100,100,'TERMINE',$1::jsonb,$2,now(),
           (SELECT id FROM public.users WHERE username='KEENAN'),
           (SELECT id FROM public.users WHERE username='KEENAN')
         ) ON CONFLICT (id) DO NOTHING`,
        [SOL20_TECHNICAL_SNAPSHOT_JSON, SOL20_TECHNICAL_SNAPSHOT_SHA256]
      );
      await client.query(
        `INSERT INTO public.of_technical_snapshots (
           of_id,piece_technique_version_id,snapshot,snapshot_sha256,created_by
         ) VALUES (
           920001,'23000000-0000-4000-8000-000000000001',$1::jsonb,$2,
           (SELECT id FROM public.users WHERE username='KEENAN')
         ) ON CONFLICT (of_id) DO NOTHING`,
        [SOL20_TECHNICAL_SNAPSHOT_JSON, SOL20_TECHNICAL_SNAPSHOT_SHA256]
      );

      const planSha256 = crypto.createHash("sha256").update(SOL20_PLAN_CONTENT).digest("hex");
      const planStorageKey = `vault/sha256/${planSha256.slice(0, 2)}/${planSha256.slice(2, 4)}/${planSha256}`;
      await ensureIsolatedGedBlob(planStorageKey, SOL20_PLAN_CONTENT);
      await client.query(
        `INSERT INTO public.ged_blobs (id,sha256,size_bytes,mime_type,storage_key,created_by)
         VALUES ('92000000-0000-4000-8000-000000000004',$1,$2,'application/pdf',$3,
           (SELECT id FROM public.users WHERE username='KEENAN'))
         ON CONFLICT (id) DO NOTHING`,
        [planSha256, SOL20_PLAN_CONTENT.byteLength, planStorageKey]
      );
      await client.query(
        `INSERT INTO public.ged_documents (id,code,class_key,title,description,created_by)
         VALUES ('92000000-0000-4000-8000-000000000005','GED-E2E-SOL20-PLAN','PLAN_CLIENT',
           'Plan applicable E2E SOL-20','Document synthétique strictement isolé',
           (SELECT id FROM public.users WHERE username='KEENAN'))
         ON CONFLICT (id) DO NOTHING`
      );
      await client.query(
        `INSERT INTO public.ged_upload_sessions (
           id,class_key,document_id,title,status,sha256,size_bytes,mime_type,original_name,
           created_by,expires_at,scan_status,quarantine_status,scan_provider,signature_version,
           scan_duration_ms,scan_attempts,scanned_at
         ) VALUES (
           '92000000-0000-4000-8000-000000000006','PLAN_CLIENT',
           '92000000-0000-4000-8000-000000000005','Plan applicable E2E SOL-20','PUBLISHED',
           $1,$2,'application/pdf','plan-sol20.pdf',(SELECT id FROM public.users WHERE username='KEENAN'),
           '2099-01-01T00:00:00Z','clean','released','isolated-e2e-scanner','E2E-SIGNATURES-1',1,1,now()
         ) ON CONFLICT (id) DO NOTHING`,
        [planSha256, SOL20_PLAN_CONTENT.byteLength]
      );
      await client.query(
        `INSERT INTO public.ged_document_versions (
           id,document_id,version_number,status,blob_id,original_name,change_reason,created_by,
           submitted_at,submitted_by,approved_at,approved_by,published_at,upload_session_id
         ) VALUES (
           '92000000-0000-4000-8000-000000000007','92000000-0000-4000-8000-000000000005',1,
           'APPLICABLE','92000000-0000-4000-8000-000000000004','plan-sol20.pdf','Preuve E2E SOL-20',
           (SELECT id FROM public.users WHERE username='KEENAN'),now(),
           (SELECT id FROM public.users WHERE username='KEENAN'),now(),
           (SELECT id FROM public.users WHERE username='E2E_QUALITY'),now(),
           '92000000-0000-4000-8000-000000000006'
         ) ON CONFLICT (id) DO NOTHING`
      );
      await client.query(
        `UPDATE public.ged_documents
            SET current_version_id='92000000-0000-4000-8000-000000000007',updated_at=now()
          WHERE id='92000000-0000-4000-8000-000000000005'`
      );
      await client.query(
        `INSERT INTO public.ged_document_links (
           id,document_id,entity_type,entity_id,link_role,created_by
         ) VALUES (
           '92000000-0000-4000-8000-000000000008','92000000-0000-4000-8000-000000000005',
           'PIECE_TECHNIQUE_VERSION','23000000-0000-4000-8000-000000000001','PLAN',
           (SELECT id FROM public.users WHERE username='KEENAN')
         ) ON CONFLICT (document_id,entity_type,entity_id,link_role) DO NOTHING`
      );
    }
    await client.query(
      `INSERT INTO public.machines (
         id,code,name,type,status,is_available,workshop_zone,machine_family_code,created_by,updated_by
       ) VALUES (
         '27000000-0000-4000-8000-000000000001','E2E-MACH-001','Machine atelier preuve SOL-21',
         'MILLING','ACTIVE',true,'USINAGE','F',
         (SELECT id FROM public.users WHERE username='KEENAN'),
         (SELECT id FROM public.users WHERE username='KEENAN')
       ) ON CONFLICT (id) DO UPDATE SET
         code=EXCLUDED.code,name=EXCLUDED.name,status='ACTIVE',is_available=true,
         workshop_zone='USINAGE',machine_family_code='F',archived_at=NULL,updated_by=EXCLUDED.updated_by`
    );
    await client.query(
      `INSERT INTO public.machines (
         id,code,name,type,status,is_available,workshop_zone,machine_family_code,created_by,updated_by
       ) VALUES (
         '27000000-0000-4000-8000-000000000002','E2E-MACH-NON-QUALIFIEE','Machine sans qualification — preuve négative',
         'MILLING','ACTIVE',true,'USINAGE',NULL,
         (SELECT id FROM public.users WHERE username='KEENAN'),
         (SELECT id FROM public.users WHERE username='KEENAN')
       ) ON CONFLICT (id) DO UPDATE SET
         code=EXCLUDED.code,name=EXCLUDED.name,status='ACTIVE',is_available=true,
         workshop_zone='USINAGE',machine_family_code=NULL,archived_at=NULL,updated_by=EXCLUDED.updated_by`
    );
    await client.query(
      `INSERT INTO public.postes (id,code,label,machine_id,currency,is_active)
       VALUES (
         '24000000-0000-4000-8000-000000000001','E2E-POSTE-001','Poste planning preuve SOL-05',
         '27000000-0000-4000-8000-000000000001','EUR',true
       )
       ON CONFLICT (id) DO UPDATE SET
         code=EXCLUDED.code,label=EXCLUDED.label,machine_id=EXCLUDED.machine_id,
         is_active=true,archived_at=NULL`
    );
    await client.query(
      `INSERT INTO public.postes (id,code,label,machine_id,currency,is_active)
       VALUES (
         '24000000-0000-4000-8000-000000000002','E2E-POSTE-NON-QUALIFIE','Poste machine sans qualification',
         '27000000-0000-4000-8000-000000000002','EUR',true
       )
       ON CONFLICT (id) DO UPDATE SET
         code=EXCLUDED.code,label=EXCLUDED.label,machine_id=EXCLUDED.machine_id,
         is_active=true,archived_at=NULL`
    );
    await client.query(
      `INSERT INTO public.pieces_techniques_operations (
         id,piece_technique_id,gamme_id,phase,ordre,designation,type_operation,poste_id,machine_id,
         machine_family_code,coef,tp,tf_unit,qte,taux_horaire,temps_fabrication,temps_total,cout_mo
       ) VALUES (
         '26000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001',
         '92000000-0000-4000-8000-000000000003',10,10,'Usinage preuve SOL-05','FRAISAGE',
         '24000000-0000-4000-8000-000000000001','27000000-0000-4000-8000-000000000001',
         'F',1,0.1,0.25,1,50,0.25,0.35,17.5
       ) ON CONFLICT (id) DO UPDATE SET
         piece_technique_id=EXCLUDED.piece_technique_id,gamme_id=EXCLUDED.gamme_id,phase=EXCLUDED.phase,
         ordre=EXCLUDED.ordre,designation=EXCLUDED.designation,poste_id=EXCLUDED.poste_id,machine_id=EXCLUDED.machine_id,
         machine_family_code=EXCLUDED.machine_family_code,
         temps_fabrication=EXCLUDED.temps_fabrication,temps_total=EXCLUDED.temps_total,
         cout_mo=EXCLUDED.cout_mo`
    );
    await client.query(
      `INSERT INTO public.quality_control_plan (
       id,code,version,label,status,trigger_type,article_id,sampling_rule,
         piece_technique_id,piece_version_id,
         owner_user_id,revision_reason,effective_from,published_at,published_by,
         created_by,updated_by
       ) VALUES (
         '28000000-0000-4000-8000-000000000001','SOL05-LOT-RELEASE',1,
         'Plan liberation lot preuve SOL-05','DRAFT','LOT_RELEASE',
         '22000000-0000-4000-8000-000000000001','ALL',
         '21000000-0000-4000-8000-000000000001','23000000-0000-4000-8000-000000000001',
         (SELECT id FROM public.users WHERE username='KEENAN'),
         'Referentiel de validation E2E isole','2026-01-01T00:00:00Z',
         NULL,NULL,
         (SELECT id FROM public.users WHERE username='KEENAN'),
         (SELECT id FROM public.users WHERE username='KEENAN')
       ) ON CONFLICT (code,version) DO NOTHING`
    );
    await client.query(
      `INSERT INTO public.quality_control_plan_characteristic (
         id,plan_id,characteristic_key,position,label,characteristic_type,value_kind,
         unit,nominal,tolerance_min,tolerance_max,precision_digits,criticality,mandatory,
         requires_instrument,method,acceptance_rule,sampling_rule,trigger_type
       ) VALUES (
         '29000000-0000-4000-8000-000000000001',
         (SELECT id FROM public.quality_control_plan WHERE code='SOL05-LOT-RELEASE' AND version=1),
         'DIMENSION-E2E',1,'Dimension de liberation E2E','DIMENSIONAL','NUMERIC',
         'mm',10,-0.1,0.1,2,'MAJOR',true,false,'Mesure E2E isolee',
         '9.9 mm <= mesure <= 10.1 mm','ALL','LOT_RELEASE'
       ) ON CONFLICT (plan_id,characteristic_key) DO NOTHING`
    );
    await client.query(
      `UPDATE public.quality_control_plan
       SET status='PUBLISHED',published_at='2026-01-01T00:00:00Z',
           published_by=(SELECT id FROM public.users WHERE username='KEENAN'),
           updated_by=(SELECT id FROM public.users WHERE username='KEENAN')
       WHERE code='SOL05-LOT-RELEASE' AND version=1 AND status='DRAFT'`
    );
    const deliveryPolicyV437 = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='quality_delivery_release_policy'
           AND column_name='label'
       ) AS available`
    );
    if (deliveryPolicyV437.rows[0]?.available) {
      await client.query(
        `INSERT INTO public.quality_delivery_release_policy (
         id,code,version,label,status,justification,rules,rules_sha256,signature_reference,
         document_reference,signed_by,signed_at,activated_by,activated_at,
         valid_from,valid_to,created_by,updated_by
       ) VALUES (
         '2a000000-0000-4000-8000-000000000001','SOL05-DELIVERY-RELEASE',1,
         'Politique livraison fixture SOL-05','ACTIVE','Fixture preexistante strictement isolee',
         $1::jsonb,$2,'SOL05-E2E-SIGNATURE','SOL05-E2E-DOCUMENT',
         (SELECT id FROM public.users WHERE username='KEENAN'),'2026-01-01T00:00:00Z',
         (SELECT id FROM public.users WHERE username='KEENAN'),'2026-01-01T00:00:00Z',
         '2026-01-01T00:00:00Z',NULL,
         (SELECT id FROM public.users WHERE username='KEENAN'),
         (SELECT id FROM public.users WHERE username='KEENAN')
       ) ON CONFLICT (code,version) DO UPDATE SET
         status='ACTIVE',label=EXCLUDED.label,justification=EXCLUDED.justification,
         rules=EXCLUDED.rules,rules_sha256=EXCLUDED.rules_sha256,
         signature_reference=EXCLUDED.signature_reference,signed_by=EXCLUDED.signed_by,
         document_reference=EXCLUDED.document_reference,signed_at=EXCLUDED.signed_at,
         activated_by=EXCLUDED.activated_by,activated_at=EXCLUDED.activated_at,
         valid_from=EXCLUDED.valid_from,valid_to=NULL,
         updated_by=EXCLUDED.updated_by`,
        [JSON.stringify(DELIVERY_QUALITY_RULES), DELIVERY_QUALITY_RULES_SHA256]
      );
    }
    await client.query(
      `INSERT INTO public.finance_billing_policies (
         id,policy_version,legal_entity_code,eligible_delivery_statuses,
         require_distinct_issuer,active,effective_from,effective_to,created_by
       ) VALUES (
         '27000000-0000-4000-8000-000000000001','SOL05-E2E-V1',$1,
         ARRAY['SHIPPED','DELIVERED']::text[],false,true,$2::date,NULL,
         (SELECT id FROM public.users WHERE username='KEENAN')
       ) ON CONFLICT (policy_version) DO UPDATE SET
         legal_entity_code=EXCLUDED.legal_entity_code,
         eligible_delivery_statuses=EXCLUDED.eligible_delivery_statuses,
         require_distinct_issuer=false,active=true,effective_from=EXCLUDED.effective_from,
         effective_to=NULL`,
      [FINANCE_ISSUER_ID, `${FINANCE_YEAR}-01-01`]
    );
    for (const [documentType, prefix] of [["FACTURE", "E2E-F-"], ["AVOIR", "E2E-A-"]]) {
      await client.query(
        `INSERT INTO public.finance_legal_sequences (
           document_type,entity_code,period_key,prefix,next_value,padding,active
         ) VALUES ($1,$2,$3,$4,1,6,true)
         ON CONFLICT (document_type,entity_code,period_key) DO UPDATE SET
           prefix=EXCLUDED.prefix,next_value=1,padding=6,active=true`,
        [documentType, FINANCE_ISSUER_ID, String(FINANCE_YEAR), prefix]
      );
    }

    // SOL-24 — preuves Project Office et temps/déplacements. Ces valeurs sont
    // exclusivement injectées dans la base jetable cerp_test protégée par assertIsolated().
    const sol24Tables = await client.query(
      `SELECT to_regclass('public.project_budget_versions') IS NOT NULL
          AND to_regclass('public.hr_kilometer_rate_versions') IS NOT NULL AS available`
    );
    if (sol24Tables.rows[0]?.available) {
    await client.query(
      `INSERT INTO public.project_projects (
         id,code,name,description,owner_id,visibility,status,start_date,target_date
       ) VALUES (
         '41000000-0000-4000-8000-000000000024','SOL24-E2E','Projet opérations SOL-24',
         'Fixture déterministe isolée — jamais une donnée de production',
         (SELECT id FROM public.users WHERE username='KEENAN'),'PRIVATE','ACTIVE',$1::date,$2::date
       ) ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name,description=EXCLUDED.description,owner_id=EXCLUDED.owner_id,
         visibility=EXCLUDED.visibility,status=EXCLUDED.status,start_date=EXCLUDED.start_date,
         target_date=EXCLUDED.target_date,updated_at=now()`,
      [`${FINANCE_YEAR}-01-01`, `${FINANCE_YEAR}-12-31`]
    );
    await client.query(
      `INSERT INTO public.project_members (id,project_id,user_id,role)
       VALUES (
         '41000000-0000-4000-8000-000000000025','41000000-0000-4000-8000-000000000024',
         (SELECT id FROM public.users WHERE username='KEENAN'),'OWNER'
       ) ON CONFLICT (project_id,user_id) DO UPDATE SET role='OWNER'`
    );
    await client.query(
      `INSERT INTO public.project_work_packages (
         id,project_id,code,title,type,status,priority,assignee_id,reporter_id,
         start_date,due_date,progress_percent,estimated_hours,spent_hours
       ) VALUES
       ('41000000-0000-4000-8000-000000000026','41000000-0000-4000-8000-000000000024',
        'SOL24-READY','Préparer la recette','TASK','DONE','NORMAL',
        (SELECT id FROM public.users WHERE username='KEENAN'),(SELECT id FROM public.users WHERE username='KEENAN'),
        CURRENT_DATE-14,CURRENT_DATE-7,100,8,8),
       ('41000000-0000-4000-8000-000000000027','41000000-0000-4000-8000-000000000024',
        'SOL24-BLOCKED','Traiter la dépendance','TASK','BLOCKED','HIGH',
        (SELECT id FROM public.users WHERE username='KEENAN'),(SELECT id FROM public.users WHERE username='KEENAN'),
        CURRENT_DATE-7,CURRENT_DATE+7,30,12,4)
       ON CONFLICT (id) DO UPDATE SET
         title=EXCLUDED.title,status=EXCLUDED.status,priority=EXCLUDED.priority,
         due_date=EXCLUDED.due_date,progress_percent=EXCLUDED.progress_percent,
         estimated_hours=EXCLUDED.estimated_hours,spent_hours=EXCLUDED.spent_hours,updated_at=now()`
    );
    await client.query(
      `INSERT INTO public.project_dependencies (id,source_work_package_id,target_work_package_id,dependency_type)
       VALUES ('41000000-0000-4000-8000-000000000028',
         '41000000-0000-4000-8000-000000000027','41000000-0000-4000-8000-000000000026','BLOCKS')
       ON CONFLICT (source_work_package_id,target_work_package_id,dependency_type) DO NOTHING`
    );
    await client.query(
      `INSERT INTO public.project_milestones (id,project_id,name,due_date,status)
       VALUES ('41000000-0000-4000-8000-000000000029','41000000-0000-4000-8000-000000000024',
         'Jalon de preuve en retard',CURRENT_DATE-3,'PLANNED')
       ON CONFLICT (id) DO UPDATE SET due_date=EXCLUDED.due_date,status='PLANNED',updated_at=now()`
    );
    await client.query(
      `INSERT INTO public.project_risks (id,project_id,title,description,probability,impact,mitigation,owner_id,status)
       VALUES ('41000000-0000-4000-8000-000000000030','41000000-0000-4000-8000-000000000024',
         'Dépendance externe de preuve','Risque isolé SOL-24',3,4,'Action E2E documentée',
         (SELECT id FROM public.users WHERE username='KEENAN'),'OPEN')
       ON CONFLICT (id) DO UPDATE SET probability=3,impact=4,status='OPEN',updated_at=now()`
    );
    await client.query(
      `INSERT INTO public.project_budget_versions (
         id,project_id,amount,currency,effective_from,definition,source_type,source_ref,
         observed_at,reliability,created_by
       ) SELECT
         '41000000-0000-4000-8000-000000000031','41000000-0000-4000-8000-000000000024',
         25000,'EUR',$1::date,'Budget de preuve exclusivement isolé','DECLARATION','SOL24-E2E-SEED',
         $1::date,'DECLARED',(SELECT id FROM public.users WHERE username='KEENAN')
       WHERE NOT EXISTS (
         SELECT 1 FROM public.project_budget_versions
         WHERE project_id='41000000-0000-4000-8000-000000000024' AND effective_to IS NULL
       )`,
      [REFERENCE_PERIOD_START]
    );

    await client.query(
      `INSERT INTO public.hr_employees (id,user_id,matricule,service,manager_user_id,status)
       VALUES
       ('42000000-0000-4000-8000-000000000024',(SELECT id FROM public.users WHERE username='KEENAN'),
        'E2E-ADMIN','Direction',NULL,'ACTIVE'),
       ('42000000-0000-4000-8000-000000000025',(SELECT id FROM public.users WHERE username='E2E_STANDARD'),
        'E2E-EMPLOYEE','Atelier',(SELECT id FROM public.users WHERE username='KEENAN'),'ACTIVE')
       ON CONFLICT (id) DO UPDATE SET
         user_id=EXCLUDED.user_id,matricule=EXCLUDED.matricule,service=EXCLUDED.service,
         manager_user_id=EXCLUDED.manager_user_id,status='ACTIVE',updated_at=now()`
    );
    await client.query(
      `INSERT INTO public.hr_employment_contracts (
         id,employee_id,contract_type,weekly_hours_target,daily_hours_target,start_date,active
       ) VALUES (
         '42000000-0000-4000-8000-000000000026','42000000-0000-4000-8000-000000000024',
         'H35',35,7,$1::date,true
       ) ON CONFLICT (id) DO UPDATE SET
         weekly_hours_target=35,daily_hours_target=7,start_date=EXCLUDED.start_date,end_date=NULL,active=true`,
      [REFERENCE_PERIOD_START]
    );
    await client.query(
      `INSERT INTO public.hr_vehicles (id,label,plate,owner_type,active)
       VALUES ('42000000-0000-4000-8000-000000000027','Véhicule société SOL-24','E2E-024','COMPANY',true)
       ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label,plate=EXCLUDED.plate,owner_type='COMPANY',active=true`
    );
    await client.query(
      `INSERT INTO public.hr_kilometer_rate_versions (
         id,owner_type,rate_per_km,currency,effective_from,definition,source_type,source_ref,
         observed_at,reliability,created_by
       ) SELECT
         '42000000-0000-4000-8000-000000000028','COMPANY',0.650000,'EUR',$1::date,
         'Taux de preuve exclusivement isolé','DECLARATION','SOL24-E2E-SEED',$1::date,'DECLARED',
         (SELECT id FROM public.users WHERE username='KEENAN')
       WHERE NOT EXISTS (
         SELECT 1 FROM public.hr_kilometer_rate_versions WHERE owner_type='COMPANY' AND effective_to IS NULL
       )`,
      [REFERENCE_PERIOD_START]
    );
    }
    await client.query("COMMIT");
    process.stdout.write(`SOL-05 deterministic seed ready: users=${USERS.length}, client=901, supplier=E2E-FOURN-001, finance_year=${FINANCE_YEAR}\n`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
