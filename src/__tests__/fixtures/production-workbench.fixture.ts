// Synthetic fixtures only. The integration suite checks the disposable database
// identity before calling this helper; this module is never part of app wiring.
import { randomUUID } from "node:crypto";
import pool from "../../config/database";
import type { AuditContext } from "../../module/production/repository/production.repository";
export async function seedProductionWorkbenchFixture(
  options: {
    draft?: boolean;
    child?: { piece: string; version: string; article: string };
    componentQuantity?: number;
  } = {},
) {
  if (
    process.env.CERP_E2E_ISOLATED !== "1" ||
    process.env.DATABASE_URL !==
      "postgresql://cerp_712@127.0.0.1:55432/cerp_test"
  )
    throw Error("Isolated fixture only");
  const tx = await pool.connect();
  await tx.query("BEGIN");
  try {
    const user = Number(
      (await tx.query(`SELECT id FROM public.users WHERE username='KEENAN'`))
        .rows[0].id,
    );
    const piece = randomUUID(),
      version = randomUUID(),
      article = randomUUID(),
      gamme = randomUUID(),
      cf = randomUUID(),
      quality = randomUUID(),
      code = `E2E712-${piece.slice(0, 8)}`;
    await tx.query(
      `UPDATE public.app_feature_flags SET enabled=true WHERE key IN ('PRODUCTION_WORKBENCH','PRODUCTION_CONSOLIDATION')`,
    );
    await tx.query(
      `INSERT INTO public.pieces_techniques(id,client_id,name_piece,code_piece,designation,statut,en_fabrication,root_piece_technique_id,version_number,piece_critique) VALUES($1::uuid,'901',$2,$2,'Pièce de démonstration préparation intégrée','ACTIVE',true,$1::uuid,1,false)`,
      [piece, code],
    );
    await tx.query(
      `INSERT INTO public.articles(id,code,designation,article_type,piece_technique_id,unite,lot_tracking,is_active,article_category,stock_managed,family_code,root_article_id,version_number,plan_index,status,is_sold,row_version)
      VALUES($1::uuid,$2,'Article démonstration préparation','PIECE_TECHNIQUE',$3::uuid,'u',true,true,'fabrique',true,'piece_finie',$1::uuid,1,1,'VALIDE',true,1)`,
      [article, code, piece],
    );
    await tx.query(
      `INSERT INTO public.articles_fabrique(article_id,family_code,piece_technique_id) VALUES($1::uuid,'piece_finie',$2::uuid)`,
      [article, piece],
    );
    await tx.query(
      `UPDATE public.pieces_techniques SET article_id=$2::uuid WHERE id=$1::uuid`,
      [piece, article],
    );
    await tx.query(
      `INSERT INTO public.piece_technique_versions(id,piece_technique_id,indice,plan_reference,statut,is_current,date_revision,date_validation,date_application,version_interne,code_metier,code_metier_normalise,document_requirements_frozen_at,document_requirements_policy)
      VALUES($1::uuid,$2::uuid,'A',$3,'BROUILLON',true,now(),now(),CURRENT_DATE,1,$3,$3,now(),'NONE')`,
      [version, piece, code],
    );
    if (options.child) {
      await tx.query(
        "UPDATE public.piece_technique_versions SET manufacturing_mode='ASSEMBLY' WHERE id=$1::uuid",
        [version],
      );
      await tx.query(
        `INSERT INTO public.pieces_techniques_nomenclature(parent_piece_technique_id,parent_piece_technique_version_id,child_piece_technique_id,child_piece_technique_version_id,child_article_id,quantite,rang)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,10)`,
        [
          piece,
          version,
          options.child.piece,
          options.child.version,
          null,
          options.componentQuantity ?? 2,
        ],
      );
    }
    if (!options.draft)
      await tx.query(
        "UPDATE public.piece_technique_versions SET statut='APPLICABLE' WHERE id=$1::uuid",
        [version],
      );
    await tx.query(
      `INSERT INTO public.centres_frais(id,code,name,designation,machine_family_code) VALUES($1::uuid,$2,'Centre démonstration','Centre démonstration','F')`,
      [cf, code],
    );
    await tx.query(
      `INSERT INTO public.gammes(id,piece_technique_version_id,code,designation,statut,is_current,created_by,updated_by) VALUES($1::uuid,$2::uuid,$3,'Gamme démonstration','APPLICABLE',true,$4,$4)`,
      [gamme, version, code, user],
    );
    await tx.query(
      `INSERT INTO public.pieces_techniques_operations(piece_technique_id,gamme_id,phase,ordre,designation,type_operation,cf_id,machine_family_code,coef,tp,tf_unit,qte,taux_horaire,temps_fabrication,temps_total,cout_mo)
      VALUES($1::uuid,$2::uuid,10,10,'Fraisage','FRAISAGE',$3::uuid,'F',1,0.1,0.25,1,50,0.25,0.35,17.5)`,
      [piece, gamme, cf],
    );
    await tx.query(
      `INSERT INTO public.ged_document_links(document_id,entity_type,entity_id,link_role,created_by) VALUES('92000000-0000-4000-8000-000000000005','PIECE_TECHNIQUE_VERSION',$1,'PLAN_CLIENT',$2)`,
      [version, user],
    );
    await tx.query(
      `INSERT INTO public.quality_control_plan(id,code,version,label,status,trigger_type,article_id,sampling_rule,piece_technique_id,piece_version_id,owner_user_id,revision_reason,effective_from,created_by,updated_by)
      VALUES($1::uuid,$2,1,'Autocontrôle de démonstration','DRAFT','IN_PROCESS',$3::uuid,'ALL',$4::uuid,$5::uuid,$6,'Fixture isolée',now(),$6,$6)`,
      [quality, code, article, piece, version, user],
    );
    await tx.query(
      `INSERT INTO public.quality_control_plan_characteristic(plan_id,characteristic_key,position,label,characteristic_type,value_kind,unit,nominal,tolerance_min,tolerance_max,precision_digits,criticality,mandatory,requires_instrument,method,acceptance_rule,sampling_rule,trigger_type)
      VALUES($1::uuid,'D1',1,'Diamètre extérieur','DIMENSIONAL','NUMERIC','mm',10,-0.1,0.1,2,'MAJOR',true,false,'Pied à coulisse','9.9 à 10.1 mm','ALL','IN_PROCESS')`,
      [quality],
    );
    await tx.query(
      `UPDATE public.quality_control_plan SET status='PUBLISHED',published_at=now(),published_by=$2 WHERE id=$1::uuid`,
      [quality, user],
    );
    const ids: number[] = [];
    for (const qty of [10, 20, 8, 12]) {
      const id = Number(
        (
          await tx.query(
            `SELECT nextval(pg_get_serial_sequence('public.ordres_fabrication','id')) AS id`,
          )
        ).rows[0].id,
      );
      await tx.query(
        `INSERT INTO public.ordres_fabrication(id,numero,client_id,article_id,piece_technique_id,quantite_lancee,statut,technical_preparation,preparation_rules_version,planning_wait_started_at,created_by,updated_by,root_of_id)
        VALUES($1,$2,'901',$3::uuid,$4::uuid,$5,'BROUILLON',jsonb_build_object('selected_version_id',$6::text),1,now()-interval '49 hours',$7,$7,$1)`,
        [id, `${code}-${qty}`, article, piece, qty, version, user],
      );
      ids.push(id);
    }
    await tx.query("COMMIT");
    const audit: AuditContext = {
      user_id: user,
      user_role: "Administrateur Systeme et Reseau",
      ip: null,
      user_agent: null,
      device_type: null,
      os: null,
      browser: null,
      path: "/production",
      page_key: "production",
      client_session_id: null,
    };
    return { ids, piece, version, article, gamme, cf, quality, audit, code };
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}

export async function seedWorkbenchStock(
  f: Awaited<ReturnType<typeof seedProductionWorkbenchFixture>>,
  quantity: number,
  status = "LIBERE",
  options: { scope?: "NEW" | "OLD"; withQuality?: boolean } = {},
) {
  if (
    process.env.CERP_E2E_ISOLATED !== "1" ||
    process.env.DATABASE_URL !==
      "postgresql://cerp_712@127.0.0.1:55432/cerp_test"
  )
    throw Error("Isolated fixture only");
  const tx = await pool.connect();
  await tx.query("BEGIN");
  try {
    const lot = randomUUID(),
      level = randomUUID(),
      batch = randomUUID(),
      location = randomUUID(),
      quality = randomUUID();
    await tx.query(
      `INSERT INTO public.locations(id,warehouse_id,code,description) SELECT $1::uuid,id,$2,'Emplacement de test préparation' FROM public.warehouses WHERE code='NEW-PF'`,
      [location, f.code],
    );
    await tx.query(
      `INSERT INTO public.lots(id,article_id,lot_code,lot_status,piece_technique_version_id,source_scope,stock_scope,created_by,updated_by) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$7,$7,$6,$6)`,
      [
        lot,
        f.article,
        f.code,
        status,
        f.version,
        f.audit.user_id,
        options.scope ?? "NEW",
      ],
    );
    await tx.query(
      `INSERT INTO public.stock_levels(id,article_id,unit_id,warehouse_id,location_id,managed_in_stock,qty_total) SELECT $1::uuid,$2::uuid,u.id,l.warehouse_id,l.id,true,$4 FROM public.units u CROSS JOIN public.locations l WHERE u.code='u' AND l.id=$3::uuid`,
      [level, f.article, location, quantity],
    );
    await tx.query(
      `INSERT INTO public.stock_batches(id,stock_level_id,batch_code,qty_total,lot_id) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid)`,
      [batch, level, f.code, quantity, lot],
    );
    if (options.withQuality !== false)
      await tx.query(
        `INSERT INTO public.quality_control(id,reference,control_type,status,result,controlled_by,validated_by,validation_date,created_by,updated_by,source_type,source_id,lot_id,article_id,unite,qty_population,qty_controlled,qty_conforming,qty_released,verdict,piece_technique_id)
      VALUES($1::uuid,$2,'FINAL','VALIDATED','OK',$3,$3,now(),$3,$3,'LOT',$4::uuid::text,$4::uuid,$5::uuid,'u',$6,$6,$6,$6,'CONFORME',$7::uuid)`,
        [quality, f.code, f.audit.user_id, lot, f.article, quantity, f.piece],
      );
    await tx.query("COMMIT");
    return { lot, level, batch, location, quality };
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}
