import bcrypt from 'bcryptjs';
import {describe,it,expect} from 'vitest';
import {tabletPinLoginSchema,tabletPinSetSchema} from '../module/auth/validators/auth.validator';

describe('Directory tablet PIN contract',()=>{
 it('only accepts a four-digit PIN and never needs it in clear text after hashing',async()=>{
  expect(tabletPinSetSchema.safeParse({pin:'0123'}).success).toBe(true);
  expect(tabletPinSetSchema.safeParse({pin:'0123',device_label:'Tablette'}).success).toBe(false);
  const device={deviceId:'00000000-0000-4000-8000-000000000000',deviceSecret:'a'.repeat(64)};
  expect(tabletPinLoginSchema.safeParse({...device,pin:'0123'}).success).toBe(true);
  expect(tabletPinLoginSchema.safeParse({...device,username:'operator',pin:'0123'}).success).toBe(true);
  for(const value of ['123','12345','12a4','１２３４'])expect(tabletPinLoginSchema.safeParse({...device,pin:value}).success).toBe(false);
  const hash=await bcrypt.hash('0123',12);
  expect(hash).not.toContain('0123');
  await expect(bcrypt.compare('0123',hash)).resolves.toBe(true);
  await expect(bcrypt.compare('0124',hash)).resolves.toBe(false);
 });
 it('does not share the terminal PIN request shape',()=>{
  expect(tabletPinLoginSchema.safeParse({deviceId:'00000000-0000-4000-8000-000000000000',deviceSecret:'a'.repeat(64),pin:'0123',site_code:'A'}).success).toBe(false);
 });
});
