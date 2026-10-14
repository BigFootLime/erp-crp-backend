import { describe,it,expect,vi,beforeEach } from "vitest";
const m=vi.hoisted(()=>({facts:vi.fn(),finance:vi.fn(),catalog:vi.fn()}));
vi.mock("../module/onboarding/repository/onboarding.repository",()=>({readSetupFacts:m.facts}));
vi.mock("../module/facturation/repository/finance-configuration.repository",()=>({repoGetFinanceConfigurationReadiness:m.finance}));
vi.mock("../module/reference-data/repository/reference-data.repository",()=>({repoReferenceCatalog:m.catalog}));
import { getSetupStatus } from "../module/onboarding/services/onboarding.service";
const ready={company_ready:true,workshop_ready:true,costs_ready:true,machine_count:2,qualified_count:2,rated_count:2,maintained_count:2,hours_ready:true,stock_ready:true,primary_biller_id:"company",login_count:1,machines:[]};
describe("initial configuration readiness and reminders",()=>{
 beforeEach(()=>{m.facts.mockResolvedValue(ready);m.finance.mockResolvedValue({readiness:{ready:true},active_policy:{legal_entity_code:"company"}});m.catalog.mockResolvedValue([{code:"HOURLY_RATES",record_count:2,missing_count:0}]);});
 it("stops the reminder once all actual prerequisites are present",async()=>{const r=await getSetupStatus(12);expect(r.complete).toBe(true);expect(r.show_reminder).toBe(false);});
 it.each([0,1,5,10])("reminds an incomplete account through login %i",async n=>{m.facts.mockResolvedValue({...ready,login_count:n,maintained_count:1});const r=await getSetupStatus(12);expect(r.sections.maintenance).toBe(false);expect(r.show_reminder).toBe(true);});
 it("stops reminders after the tenth login but retains the incomplete status",async()=>{m.facts.mockResolvedValue({...ready,login_count:11,machine_count:0});const r=await getSetupStatus(12);expect(r.show_reminder).toBe(false);expect(r.complete).toBe(false);});
 it("does not treat finance for another company as complete",async()=>{m.finance.mockResolvedValue({readiness:{ready:true},active_policy:{legal_entity_code:"other"}});expect((await getSetupStatus(12)).sections.finance).toBe(false);});
 it("does not invent readiness when a source fails",async()=>{m.catalog.mockRejectedValueOnce(new Error("unavailable"));await expect(getSetupStatus(12)).rejects.toThrow("unavailable");});
});
