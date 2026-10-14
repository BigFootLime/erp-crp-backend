import { readSetupFacts } from "../repository/onboarding.repository";
import { repoGetFinanceConfigurationReadiness } from "../../facturation/repository/finance-configuration.repository";
import { repoReferenceCatalog } from "../../reference-data/repository/reference-data.repository";
export const SETUP_REMINDER_LOGINS=10;
export async function getSetupStatus(userId:number,directoryLoginCount?:number) {
 const [facts,finance,references]=await Promise.all([readSetupFacts(userId),repoGetFinanceConfigurationReadiness({}),repoReferenceCatalog()]);
 if(directoryLoginCount!==undefined)facts.login_count=directoryLoginCount;
 const sections={company:!!facts.company_ready,workshop:!!facts.workshop_ready,costs:!!facts.costs_ready && (facts.machine_count===0 || facts.rated_count===facts.machine_count),
  machines:facts.machine_count>0 && facts.qualified_count===facts.machine_count,maintenance:facts.machine_count>0 && facts.maintained_count===facts.machine_count,
  hours:!!facts.hours_ready,stock:!!facts.stock_ready,finance:finance.readiness.ready && finance.active_policy?.legal_entity_code===facts.primary_biller_id,
  references:references.every(r=>r.missing_count===0 && (!["HOURLY_RATES","PRODUCTION_CALENDARS","STOCK_VALUATION"].includes(r.code) || r.record_count>0))};
 const complete=Object.values(sections).every(Boolean);
 return {sections,complete,login_count:facts.login_count,reminder_limit:SETUP_REMINDER_LOGINS,
  show_reminder:!complete && facts.login_count<=SETUP_REMINDER_LOGINS,current_step:facts.current_step ?? "company",machines:facts.machines,
  references:references.map(r=>({code:r.code,label:r.label,record_count:r.record_count,missing_count:r.missing_count}))};
}
