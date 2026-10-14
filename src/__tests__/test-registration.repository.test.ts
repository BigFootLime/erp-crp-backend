import { beforeEach,describe,it,expect,vi } from "vitest";
const mocks=vi.hoisted(()=>({connect:vi.fn(),query:vi.fn(),audit:vi.fn(),session:vi.fn(),authorization:vi.fn()}));
vi.mock("../config/database",()=>({default:{connect:mocks.connect,query:mocks.query}}));
vi.mock("../module/audit-logs/repository/audit-logs.repository",()=>({repoInsertAuditLog:mocks.audit}));
vi.mock("../shared/realtime/realtime-control-plane",()=>({bumpRealtimeSessionEpoch:mocks.session,bumpRealtimeAuthorizationEpoch:mocks.authorization}));
import { registerTestAccount,registrationEnabled } from "../module/auth/repository/test-registration.repository";
const input={username:"TEST",name:"TEST",surname:"COMPTE",email:"test@example.test",password:"Exemple!Fort12",avatar_key:"programmer" as const,weekly_hours_target:35,daily_hours_target:7,day_start:"08:00",day_end:"16:00",break_minutes:60,working_days:[1,5,7]};
const meta={ip:null,user_agent:null,device_type:null,os:null,browser:null,path:"/api/v1/auth/test-registration"};
const key="12345678-1234-4234-8234-123456789abc",hash="a".repeat(64);
describe("test registration transaction",()=>{
 beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("CERP_TEST_REGISTRATION_ENABLED","true");});
 it("requires opt-in and the actual exact test database",async()=>{
  mocks.query.mockResolvedValue({rows:[{database:"cerp_prod"}]});expect(await registrationEnabled()).toBe(false);
  mocks.query.mockResolvedValue({rows:[{database:"other_test"}]});expect(await registrationEnabled()).toBe(false);
  mocks.query.mockResolvedValue({rows:[{database:"cerp_test"}]});expect(await registrationEnabled()).toBe(true);
  vi.stubEnv("CERP_TEST_REGISTRATION_ENABLED","false");mocks.query.mockClear();expect(await registrationEnabled()).toBe(false);expect(mocks.query).not.toHaveBeenCalled();
 });
 it("refuses production before inserting any account",async()=>{
  const query=vi.fn().mockResolvedValue({rows:[{database:"cerp_prod"}]});const client={query,release:vi.fn()};mocks.connect.mockResolvedValue(client);
  await expect(registerTestAccount(input,"hash",key,hash,meta)).rejects.toMatchObject({code:"TEST_REGISTRATION_DISABLED"});
  expect(query.mock.calls.some(([sql])=>sql.includes("INSERT"))).toBe(false);expect(query).toHaveBeenCalledWith("ROLLBACK");expect(client.release).toHaveBeenCalledOnce();
 });
 it("creates account, RH targets, weekdays and sanitized audit atomically",async()=>{
  const query=vi.fn(async(sql:string)=>({rows:sql.includes("current_database") ? [{database:"cerp_test"}] : sql.includes("INSERT INTO public.users") ? [{id:45}] : sql.includes("INSERT INTO public.hr_employees") ? [{id:"employee"}] : [],rowCount:1}));
  const client={query,release:vi.fn()};mocks.connect.mockResolvedValue(client);
  const result=await registerTestAccount(input,"bcrypt-hash",key,hash,meta);
  expect(result).toMatchObject({userId:45,replayed:false});
  const userInsert=query.mock.calls.find(([sql])=>sql.includes("INSERT INTO public.users"))!;
  expect(userInsert[0]).toContain("'Active',true,true");expect(userInsert[0]).toContain("'Administrateur Systeme et Reseau'");expect(JSON.stringify(userInsert)).not.toContain(input.password);
  const schedules=query.mock.calls.filter(([sql])=>sql.includes("INSERT INTO public.hr_work_schedules"));
  expect(schedules.map(call=>(call as unknown as [string,unknown[]])[1][1])).toEqual([1,5,0]);
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({tx:client,body:expect.objectContaining({action:"AUTH_TEST_ACCOUNT_CREATED"})}));
  expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(input.email);expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
 });
 it("replays without a second account or second audit",async()=>{
  const query=vi.fn(async(sql:string)=>({rows:sql.includes("current_database") ? [{database:"cerp_test"}] : sql.includes("FROM public.test_account_registrations") ? [{user_id:45,request_hash:hash}] : []}));
  mocks.connect.mockResolvedValue({query,release:vi.fn()});
  expect(await registerTestAccount(input,"bcrypt-hash",key,hash,meta)).toMatchObject({userId:45,replayed:true});
  expect(query.mock.calls.some(([sql])=>sql.includes("INSERT INTO public.users"))).toBe(false);expect(mocks.audit).not.toHaveBeenCalled();
 });
 it("rejects key reuse with another request",async()=>{
  const query=vi.fn(async(sql:string)=>({rows:sql.includes("current_database") ? [{database:"cerp_test"}] : sql.includes("FROM public.test_account_registrations") ? [{user_id:45,request_hash:"b".repeat(64)}] : []}));
  mocks.connect.mockResolvedValue({query,release:vi.fn()});await expect(registerTestAccount(input,"hash",key,hash,meta)).rejects.toMatchObject({code:"REGISTRATION_KEY_REUSED"});
 });
});
