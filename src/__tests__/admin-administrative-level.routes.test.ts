import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({active:vi.fn(),superadmin:vi.fn(),directory:vi.fn(),change:vi.fn(),getUser:vi.fn(),target:vi.fn(),directoryUser:vi.fn()}));
vi.mock('../module/auth/repository/auth.repository',()=>({findAuthenticatedAccountState:mocks.active}));
vi.mock('../module/access-control/services/access-control.service',()=>({isSuperadmin:mocks.superadmin}));
vi.mock('../module/admin/services/admin.service',()=>({getUser:mocks.getUser}));
vi.mock('../shared-directory/site-runtime',()=>({sharedDirectoryClient:mocks.directory,validateSiteDirectoryToken:vi.fn(async(_db,claims)=>({username:claims.username,email:claims.email,role:claims.role,roles:[claims.role]}))}));
vi.mock('../shared-directory/admin.facade',()=>({directoryAdminSuperadmin:mocks.change,directoryTargetId:mocks.target,directoryAdminUser:mocks.directoryUser}));

import adminRoutes from '../module/admin/routes/admin.routes';
import {validationErrorMiddleware} from '../module/auth/middlewares/validationError.middleware';
import {errorHandler} from '../middlewares/errorHandler';

const secret='admin-administrative-level-test-secret-with-at-least-thirty-two-characters';
const priorSecret=process.env.JWT_SECRET;
const priorProfile=process.env.CERP_DEPLOYMENT_PROFILE;
const app=express();app.use(express.json());app.use('/api/v1/admin',adminRoutes);app.use(validationErrorMiddleware);app.use(errorHandler);
const token=()=>jwt.sign({id:7,username:'OWNER',email:'owner@example.test',role:'Employee',session_epoch:0},secret);

beforeAll(()=>{process.env.JWT_SECRET=secret;process.env.CERP_DEPLOYMENT_PROFILE='internal';});
afterAll(()=>{if(priorSecret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=priorSecret;if(priorProfile===undefined)delete process.env.CERP_DEPLOYMENT_PROFILE;else process.env.CERP_DEPLOYMENT_PROFILE=priorProfile;});
beforeEach(()=>{vi.resetAllMocks();mocks.active.mockResolvedValue({status:'Active',session_epoch:0});mocks.superadmin.mockResolvedValue(true);mocks.directory.mockReturnValue({});mocks.getUser.mockResolvedValue({id:11,username:'LOCAL'});});

describe('administrative-level authority metadata',()=>{
 it('marks a genuinely local authority read-only without inventing a membership version',async()=>{
  mocks.directory.mockReturnValue(null);
  const response=await request(app).get('/api/v1/admin/users/11').set('Authorization',`Bearer ${token()}`);
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toMatchObject({user:{id:11},administrative_level_authority:'LOCAL_READ_ONLY'});
  expect(response.body.user.membership_version).toBeUndefined();
 });

 it('marks a successful directory read as DIRECTORY, including canonical version zero',async()=>{
  mocks.target.mockResolvedValue('11111111-1111-4111-8111-111111111111');
  mocks.directoryUser.mockResolvedValue({user:{id:11,is_superadmin:true,membership_version:0}});
  const response=await request(app).get('/api/v1/admin/users/11').set('Authorization',`Bearer ${token()}`);
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toMatchObject({user:{id:11,membership_version:0},administrative_level_authority:'DIRECTORY'});
 });

 it('never relabels a failed directory read as local',async()=>{
  mocks.target.mockResolvedValue('11111111-1111-4111-8111-111111111111');
  mocks.directoryUser.mockRejectedValue(new Error('directory unreachable'));
  const response=await request(app).get('/api/v1/admin/users/11').set('Authorization',`Bearer ${token()}`);
  expect(response.status).toBe(500);
  expect(response.body.administrative_level_authority).toBeUndefined();
 });
});

describe('administrative-level route',()=>{
 it('forwards only the reviewed level mutation to the shared directory facade',async()=>{
  mocks.change.mockResolvedValue({user:{id:11,is_superadmin:true,membership_version:8},changed:true});
  const response=await request(app).patch('/api/v1/admin/users/11/administrative-level').set('Authorization',`Bearer ${token()}`).send({is_superadmin:true,expected_version:7});
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(mocks.change).toHaveBeenCalledWith(expect.anything(),expect.anything(),11,{is_superadmin:true,expected_version:7});
 });

 it('rejects local-marker payloads and a disabled shared authority',async()=>{
  const invalid=await request(app).patch('/api/v1/admin/users/11/administrative-level').set('Authorization',`Bearer ${token()}`).send({is_superadmin:true,expected_version:7,local_marker:true});
  expect(invalid.status).toBe(400);
  expect(mocks.change).not.toHaveBeenCalled();
  mocks.directory.mockReturnValue(null);
  const unavailable=await request(app).patch('/api/v1/admin/users/11/administrative-level').set('Authorization',`Bearer ${token()}`).send({is_superadmin:false,expected_version:7});
  expect(unavailable.status).toBe(409);
  expect(unavailable.body.code).toBe('DIRECTORY_AUTHORITY_REQUIRED');
 });
});
