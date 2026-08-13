#!/usr/bin/env node

const { Client } = require("pg");
const crypto = require("node:crypto");

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
  ["E2E_QUALITY", "Qualite", "E2E", "quality.e2e@invalid.example", "Responsable Qualité", false, "Qualité"],
  ["E2E_PURCHASING", "Achats", "E2E", "purchasing.e2e@invalid.example", "Directeur", false, "Achats"],
  ["E2E_ACCOUNTANT", "Comptabilite", "E2E", "accounting.e2e@invalid.example", "Directeur", false, "RH-Financier"],
];

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
         delivery_address_id='91000000-0000-4000-8000-000000000001',
         bill_address_id='92000000-0000-4000-8000-000000000001',
         contact_id='93000000-0000-4000-8000-000000000001'
       WHERE client_id='901'`
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
         id,piece_technique_id,indice,statut,is_current,date_revision,date_validation,
         date_application,version_interne,code_metier,code_metier_normalise,
         document_requirements_frozen_at,document_requirements_policy
       ) VALUES (
         '23000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001',
         'A','APPLICABLE',true,now(),now(),CURRENT_DATE,1,'E2E-PT-001-A','E2E-PT-001-A',now(),'NONE'
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
    await client.query(
      `INSERT INTO public.postes (id,code,label,currency,is_active)
       VALUES ('24000000-0000-4000-8000-000000000001','E2E-POSTE-001','Poste planning preuve SOL-05','EUR',true)
       ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code,label=EXCLUDED.label,is_active=true,archived_at=NULL`
    );
    await client.query(
      `INSERT INTO public.pieces_techniques_operations (
         id,piece_technique_id,phase,ordre,designation,type_operation,poste_id,
         coef,tp,tf_unit,qte,taux_horaire,temps_fabrication,temps_total,cout_mo
       ) VALUES (
         '26000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001',
         10,10,'Usinage preuve SOL-05','FRAISAGE','24000000-0000-4000-8000-000000000001',
         1,0.1,0.25,1,50,0.25,0.35,17.5
       ) ON CONFLICT (id) DO UPDATE SET
         piece_technique_id=EXCLUDED.piece_technique_id,phase=EXCLUDED.phase,
         ordre=EXCLUDED.ordre,designation=EXCLUDED.designation,poste_id=EXCLUDED.poste_id,
         temps_fabrication=EXCLUDED.temps_fabrication,temps_total=EXCLUDED.temps_total,
         cout_mo=EXCLUDED.cout_mo`
    );
    await client.query(
      `INSERT INTO public.quality_control_plan (
         id,code,version,label,status,trigger_type,article_id,sampling_rule,
         owner_user_id,revision_reason,effective_from,published_at,published_by,
         created_by,updated_by
       ) VALUES (
         '28000000-0000-4000-8000-000000000001','SOL05-LOT-RELEASE',1,
         'Plan liberation lot preuve SOL-05','DRAFT','LOT_RELEASE',
         '22000000-0000-4000-8000-000000000001','ALL',
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
