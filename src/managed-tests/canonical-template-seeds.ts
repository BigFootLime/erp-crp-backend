import type {Client} from 'pg';

type Db = Pick<Client, 'query'>;
const FLAGS = {
  COMMAND_ASSEMBLY_FLOW: 'Assemblages dans les commandes clients',
  DASHBOARD_ARIANE_DEFAULT: 'ARIANE par défaut',
  DASHBOARD_USAGE_METRICS: 'Mesure indicative de convergence dashboard',
  PLANNING_LEGACY_DASHBOARD_RETIREMENT: 'Retrait du planning dashboard historique',
  PLANNING_USAGE_METRICS: 'Mesure indicative des surfaces planning',
  PRODUCTION_CONSOLIDATION: 'Regroupement des ordres de fabrication',
  PRODUCTION_MATERIAL_WORKFLOW: 'Dossier et parcours matière',
  PRODUCTION_WORKBENCH: 'Préparation des ordres de fabrication',
  PROJECT_OFFICE: 'Gestion de projet',
} as const;
type FlagKey = keyof typeof FLAGS;
type Flag = {key: FlagKey; enabled: boolean; environment: string};
export type CanonicalTemplatePolicy = {flags: Flag[]; planning: {activation: string; estimation_policy: string}};

/** Code-owned metadata only. No business data, accounts, grants or company configuration. */
export const CANONICAL_TECHNICAL_TABLES = [
  'ged_entity_types', 'app_feature_flags', 'planning_forecast_state', 'planning_learning_state',
  'api_webhook_ingestion_state', 'delivery_prepayment_epoch_1268', 'stock_valuation_projector_control',
  'stock_valuation_capture_boundary', 'stock_valuation_acquisition_boundary',
  'stock_valuation_return_boundary', 'stock_valuation_manufacturing_boundary',
  'finance_ged_profile_state_1268',
] as const;

// Canonical profiles from the closed GED contract and Finance #1268, not from document rows.
const GED = [
  ['CLIENT','Client','clients','clients','client_id',10],
  ['FOURNISSEUR','Fournisseur','fournisseurs','fournisseurs','id',20],
  ['ARTICLE','Article','stock','articles','id',30],
  ['PIECE_TECHNIQUE','Pièce technique','pieces-techniques','pieces_techniques','id',40],
  ['PIECE_TECHNIQUE_VERSION','Indice de pièce','pieces-techniques','piece_technique_versions','id',50],
  ['AFFAIRE','Affaire','affaires','affaire','id',60],
  ['DEVIS','Devis','devis','devis','id',65],
  ['COMMANDE_CLIENT','Commande client','commande-client','commande_client','id',70],
  ['COMMANDE_FOURNISSEUR','Commande fournisseur','commandes-fournisseurs','commande_fournisseur','id',75],
  ['OF','Ordre de fabrication','production','ordres_fabrication','id',80],
  ['BON_LIVRAISON','Bon de livraison','livraisons','bon_livraison','id',85],
  ['RECEPTION','Réception','receptions','receptions_fournisseurs','id',90],
  ['CONTROLE_QUALITE','Contrôle qualité','qualite','quality_control','id',100],
  ['MACHINE','Machine','production','machines','id',110],
  ['UTILISATEUR','Utilisateur','users','users','id',120],
  ['FACTURE','Facture','facturation','facture','id',125],
  ['PROFORMA','Proforma','facturation','proforma_client','id',127],
  ['AVOIR','Avoir','facturation','avoir','id',130],
] as const;
const profiles = GED.map(([entity_type,label,module_key,target_table,target_pk_column,sort_order])=>({entity_type,label,module_key,target_table,target_pk_column,sort_order}));

function validatePolicy(value: CanonicalTemplatePolicy): CanonicalTemplatePolicy {
  if (!value || !Array.isArray(value.flags) || value.flags.length !== Object.keys(FLAGS).length ||
      new Set(value.flags.map(flag=>flag.key)).size !== value.flags.length ||
      value.flags.some(flag=>!Object.prototype.hasOwnProperty.call(FLAGS,flag.key) || typeof flag.enabled!=='boolean' || !['all','test','production','development'].includes(flag.environment)) ||
      !['OBSERVE','READ','SIMULATE','COMMIT','EXECUTE','LEARN'].includes(value.planning?.activation) ||
      !['cerp-duration-v1','cerp-duration-v2'].includes(value.planning?.estimation_policy)) {
    throw new Error('MANAGED_TEMPLATE_TECHNICAL_POLICY_INVALID');
  }
  return value;
}

/** Retain only already authorized feature switches, never user overrides or workshop calendars. */
export async function readCanonicalTemplatePolicy(source: Db): Promise<CanonicalTemplatePolicy> {
  const row=(await source.query<{database:string;flags:Flag[];planning:CanonicalTemplatePolicy['planning']}>(`
    SELECT current_database() AS database,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('key',key,'enabled',enabled,'environment',environment) ORDER BY key),'[]'::jsonb) FROM public.app_feature_flags) AS flags,
      (SELECT jsonb_build_object('activation',activation,'estimation_policy',estimation_policy) FROM public.planning_central_settings WHERE singleton) AS planning
  `)).rows[0];
  if (!row || row.database!=='cerp_test' || row.flags.some(flag=>!Object.prototype.hasOwnProperty.call(FLAGS,flag.key)&&flag.enabled)) throw new Error('MANAGED_TEMPLATE_TECHNICAL_SOURCE_INVALID');
  const flags=(Object.keys(FLAGS) as FlagKey[]).map(key=>row.flags.find(flag=>flag.key===key)??{key,enabled:false,environment:'all'});
  return validatePolicy({flags,planning:row.planning});
}

/** Only during empty-template creation, after pre-data and before restoring post-data triggers. */
export async function seedCanonicalTemplateMetadata(target: Db, rawPolicy: CanonicalTemplatePolicy): Promise<void> {
  const policy=validatePolicy(rawPolicy);
  const blank=(await target.query<{empty:boolean}>(`SELECT NOT EXISTS(SELECT 1 FROM public.users)
    AND NOT EXISTS(SELECT 1 FROM public.ordres_fabrication) AND NOT EXISTS(SELECT 1 FROM public.facture)
    AND NOT EXISTS(SELECT 1 FROM public.ged_documents) AS empty`)).rows[0];
  if (!blank?.empty) throw new Error('MANAGED_TEMPLATE_HAS_BUSINESS_DATA');
  await target.query(`INSERT INTO public.ged_entity_types(entity_type,label,module_key,target_table,target_pk_column,sort_order,is_active)
    SELECT entity_type,label,module_key,target_table,target_pk_column,sort_order,true FROM jsonb_to_recordset($1::jsonb)
      AS entry(entity_type text,label text,module_key text,target_table text,target_pk_column text,sort_order integer)
    WHERE NOT EXISTS(SELECT 1 FROM public.ged_entity_types current WHERE current.entity_type=entry.entity_type)`,[JSON.stringify(profiles)]);
  await target.query(`INSERT INTO public.app_feature_flags(key,name,enabled,environment)
    SELECT key,name,enabled,environment FROM jsonb_to_recordset($1::jsonb) AS entry(key text,name text,enabled boolean,environment text)
    WHERE NOT EXISTS(SELECT 1 FROM public.app_feature_flags current WHERE current.key=entry.key)`,[JSON.stringify(policy.flags.map(flag=>({...flag,name:FLAGS[flag.key]})))]);
  await target.query(`UPDATE public.planning_central_settings SET activation=$1,estimation_policy=$2 WHERE singleton
    AND (activation IS DISTINCT FROM $1 OR estimation_policy IS DISTINCT FROM $2)`,[policy.planning.activation,policy.planning.estimation_policy]);
  // WHERE NOT EXISTS makes an already seeded metadata row a read-only replay even
  // after immutable Stock boundary triggers have been restored.
  for (const table of [
    'planning_forecast_state','planning_learning_state','delivery_prepayment_epoch_1268',
    'stock_valuation_projector_control','stock_valuation_capture_boundary','stock_valuation_acquisition_boundary',
    'stock_valuation_return_boundary','stock_valuation_manufacturing_boundary',
  ] as const) await target.query(`INSERT INTO public.${table}(singleton) SELECT true WHERE NOT EXISTS(SELECT 1 FROM public.${table})`);
  await target.query(`INSERT INTO public.api_webhook_ingestion_state(singleton,last_outbox_created_at,last_outbox_id)
    SELECT true,'-infinity'::timestamptz,'00000000-0000-0000-0000-000000000000'::uuid WHERE NOT EXISTS(SELECT 1 FROM public.api_webhook_ingestion_state)`);
  await target.query(`INSERT INTO public.finance_ged_profile_state_1268(singleton,registry_created)
    SELECT true,false WHERE NOT EXISTS(SELECT 1 FROM public.finance_ged_profile_state_1268)`);
}

export async function assertCanonicalTemplateMetadata(target: Db, policy?: CanonicalTemplatePolicy): Promise<void> {
  for (const table of CANONICAL_TECHNICAL_TABLES.filter(name=>name!=='ged_entity_types'&&name!=='app_feature_flags')) {
    if ((await target.query<{n:string}>(`SELECT count(*)::text AS n FROM public.${table} WHERE singleton`)).rows[0]?.n!=='1') throw new Error('MANAGED_TEMPLATE_TECHNICAL_METADATA_MISSING');
  }
  const ged=(await target.query<{ok:boolean}>(`SELECT (SELECT count(*) FROM public.ged_entity_types)=18 AND NOT EXISTS(
    SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS expected(entity_type text,module_key text,target_table text,target_pk_column text)
    LEFT JOIN public.ged_entity_types actual USING(entity_type)
    WHERE actual.entity_type IS NULL OR NOT actual.is_active OR actual.module_key<>expected.module_key
      OR actual.target_table<>expected.target_table OR actual.target_pk_column<>expected.target_pk_column) AS ok`,[JSON.stringify(profiles)])).rows[0];
  if(!ged?.ok) throw new Error('MANAGED_TEMPLATE_GED_REGISTRY_INVALID');
  const clean=(await target.query<{ok:boolean}>(`SELECT
    (SELECT mode='PREPARED' AND NOT initialized AND last_sequence=0 AND formula_version='CERP-CUMP-1.0.0' FROM public.stock_valuation_projector_control WHERE singleton)
    AND (SELECT version=0 AND writer_transaction=0 FROM public.delivery_prepayment_epoch_1268 WHERE singleton)
    AND (SELECT calculated_at IS NULL AND processed_operations=0 AND last_error IS NULL FROM public.planning_learning_state WHERE singleton)
    AND (SELECT calculated_at IS NULL AND source_revision IS NULL AND issue_count=0 AND last_error IS NULL FROM public.planning_forecast_state WHERE singleton)
    AND (SELECT last_outbox_created_at='-infinity'::timestamptz AND last_outbox_id='00000000-0000-0000-0000-000000000000'::uuid FROM public.api_webhook_ingestion_state WHERE singleton)
    AND (SELECT count(*)=9 FROM public.app_feature_flags) AS ok`)).rows[0];
  if(!clean?.ok) throw new Error('MANAGED_TEMPLATE_TECHNICAL_STATE_DIRTY');
  if(policy){
    validatePolicy(policy);
    const result=(await target.query<{ok:boolean}>(`SELECT NOT EXISTS(
      SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS expected(key text,enabled boolean,environment text)
      LEFT JOIN public.app_feature_flags actual USING(key)
      WHERE actual.key IS NULL OR actual.enabled<>expected.enabled OR actual.environment<>expected.environment)
      AND (SELECT activation=$2 AND estimation_policy=$3 FROM public.planning_central_settings WHERE singleton) AS ok`,
      [JSON.stringify(policy.flags),policy.planning.activation,policy.planning.estimation_policy])).rows[0];
    if(!result?.ok) throw new Error('MANAGED_TEMPLATE_TECHNICAL_POLICY_CHANGED');
  }
}
