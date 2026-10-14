import { describe,it,expect } from "vitest";
import { testRegistrationSchema } from "../module/auth/validators/test-registration.validator";
const valid={username:"élise.martin",name:"Élise",surname:"Martin",email:"Elise@Example.test",password:"Exemple!Fort12",avatar_key:"programmer",weekly_hours_target:35,daily_hours_target:7,day_start:"08:00",day_end:"16:00",break_minutes:60,working_days:[1,2,3,4,5]};
describe("test registration boundary",()=>{
 it("normalizes identity and retains the 3D programmer avatar",()=>{
  expect(testRegistrationSchema.parse(valid)).toMatchObject({username:"ÉLISE.MARTIN",name:"ÉLISE",surname:"MARTIN",email:"elise@example.test",avatar_key:"programmer"});
 });
 it.each([{role:"Employee"},{is_superadmin:false},{database:"cerp_prod"},{extra:"x"}])("rejects client-owned privilege or database fields %j",extra=>{
  expect(testRegistrationSchema.safeParse({...valid,...extra}).success).toBe(false);
 });
 it.each([{working_days:[]},{working_days:[1,1]},{avatar_key:"../../file"},{day_end:"07:00"},{break_minutes:480},{weekly_hours_target:169},{daily_hours_target:0},{password:"faible"},{daily_hours_target:7.123}])("rejects invalid inputs %j",patch=>{
  expect(testRegistrationSchema.safeParse({...valid,...patch}).success).toBe(false);
 });
 it("rejects passwords truncated by bcrypt's byte limit",()=>{
  expect(testRegistrationSchema.safeParse({...valid,password:"A!1a"+"é".repeat(35)}).success).toBe(false);
 });
});
