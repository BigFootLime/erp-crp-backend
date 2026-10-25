import express from 'express';
import cors from 'cors';
import {createServer,request as upstreamRequest,type IncomingMessage} from 'node:http';
import type {Duplex} from 'node:stream';
import {z} from 'zod';
import {ManagedRegistry} from './registry';
import {authorizeManager} from './authorization';
import {ManagerError,managedDatabaseIdSchema,publicInstance,type ManagedInstance} from './model';
import type {TestInstanceHelper} from './helper-client';

type Options={registry:ManagedRegistry;helper:TestInstanceHelper;commonApi:string;origins:string[];enabled:boolean;authorize?:(authorization:string|undefined)=>Promise<number>};
const commandKey=z.string().guid(),deleteBody=z.object({confirmation:z.string().max(80)}).strict();
export function createManagedTestBroker(options:Options) {
  const app=express(),server=createServer(app);
  const connections=new Map<string,Set<Duplex>>();
  const running=new Set<string>();let tail:Promise<void>=Promise.resolve(),ready=false,templateVersion='unavailable',stopping=false,activeMutations=0;
  const mutation=(work:(req:express.Request,res:express.Response,next:express.NextFunction)=>Promise<void>):express.RequestHandler=>(req,res,next)=>{if(stopping){res.status(503).json({code:'MANAGED_SERVICE_UNAVAILABLE',message:'Réessayez dans un instant.'});return;}activeMutations++;void work(req,res,next).catch(next).finally(()=>{activeMutations--;});};
  function closeConnections(id:string){for(const socket of connections.get(id)??[]) socket.destroy();connections.delete(id);}
  function track(id:string,socket:Duplex){const sockets=connections.get(id)??new Set<Duplex>();sockets.add(socket);connections.set(id,sockets);socket.once('close',()=>{sockets.delete(socket);if(sockets.size===0) connections.delete(id);});}
  function enqueue(i:ManagedInstance) {
    if(running.has(i.id) || !['CREATING','DELETING','FAILED'].includes(i.state)) return;
    running.add(i.id);tail=tail.then(async()=>{
      const current=options.registry.find(i.id);if(!current || current.state==='DELETED') return;
      try {
        if(current.state==='DELETING') {closeConnections(i.id);const result=await options.helper.delete(current);if(result.id!==i.id || !result.deleted) throw new Error('MANAGED_HELPER_IDENTITY_MISMATCH');await options.registry.update(i.id,{state:'DELETED',port:null,error_code:null});}
        else {await options.registry.update(i.id,{state:'CREATING',error_code:null});const result=await options.helper.create(current);if(result.id!==i.id || !result.port) throw new Error('MANAGED_HELPER_IDENTITY_MISMATCH');await options.registry.update(i.id,{state:'READY',port:result.port,template_version:result.template_version,error_code:null});}
      }catch(error){const code=error instanceof ManagerError ? error.code:'MANAGED_OPERATION_FAILED';await options.registry.update(i.id,{state:current.state==='DELETING' ? 'DELETING':'FAILED',error_code:code});console.error(JSON.stringify({event:'managed_test_operation_failed',id:i.id,code}));}
      finally{running.delete(i.id);}
    }).catch(()=>{running.delete(i.id);ready=false;});
  }
  app.disable('x-powered-by');
  app.use('/api/v1/test-databases',cors({origin:(origin,done)=>done(null,!origin || options.origins.includes(origin)),methods:['GET','POST','DELETE','OPTIONS'],allowedHeaders:['Authorization','Content-Type','X-CERP-Database','Idempotency-Key','X-Page-Key','X-Client-Session-Id','X-Request-Id','X-Correlation-Id'],maxAge:300}));
  app.get('/api/v1/test-databases',(_req,res)=>res.set('Cache-Control','no-store').json({enabled:options.enabled,create_available:options.enabled && ready,template_version:templateVersion,instances:options.registry.snapshot().instances.filter(i=>i.state!=='DELETED').map(publicInstance)}));
  const json=express.json({limit:'2kb'});
  async function actor(authorization:string|undefined){if(!options.enabled) throw new ManagerError(503,'MANAGED_NOT_READY','La gestion des bases Test n’est pas encore disponible.');return options.authorize ? options.authorize(authorization):authorizeManager(authorization,options.commonApi);}
  app.post('/api/v1/test-databases',json,mutation(async(req,res,next)=>{try {
    const actorId=await actor(req.headers.authorization),key=commandKey.parse(req.headers['idempotency-key']);z.object({}).strict().parse(req.body);
    if(!ready) throw new ManagerError(503,'MANAGED_NOT_READY','La création de bases Test n’est pas encore disponible.');
    const result=await options.registry.command('CREATE',actorId,key);enqueue(result.instance);res.status(202).json({...publicInstance(result.instance),replayed:result.replayed});
  }catch(error){next(error);}}));
  app.delete('/api/v1/test-databases/:id',json,mutation(async(req,res,next)=>{try {
    const actorId=await actor(req.headers.authorization),id=managedDatabaseIdSchema.parse(req.params.id),key=commandKey.parse(req.headers['idempotency-key']),body=deleteBody.parse(req.body);
    const result=await options.registry.command('DELETE',actorId,key,id,body.confirmation);closeConnections(id);enqueue(result.instance);res.status(202).json({...publicInstance(result.instance),replayed:result.replayed});
  }catch(error){next(error);}}));
  app.post('/api/v1/test-databases/:id/retry',json,mutation(async(req,res,next)=>{try{
    const actorId=await actor(req.headers.authorization),id=managedDatabaseIdSchema.parse(req.params.id),key=commandKey.parse(req.headers['idempotency-key']);z.object({}).strict().parse(req.body);
    if(!ready) throw new ManagerError(503,'MANAGED_NOT_READY','La création de bases Test n’est pas encore disponible.');
    const result=await options.registry.command('RETRY',actorId,key,id);enqueue(result.instance);res.status(202).json({...publicInstance(result.instance),replayed:result.replayed});
  }catch(error){next(error);}}));
  function destination(req:IncomingMessage) {
    const rawHeader=req.headers['x-cerp-database'],header=typeof rawHeader==='string' ? rawHeader:null;
    const socketPath=new URL(req.url??'/', 'http://localhost'),query=socketPath.searchParams.getAll('database');
    const id=socketPath.pathname.startsWith('/socket.io/') ? query.length===1 ? query[0]:null:header;
    if(!id || !managedDatabaseIdSchema.safeParse(id).success || (header && query.length && header!==query[0])) throw new ManagerError(400,'MANAGED_DATABASE_INVALID','Choisissez une base Test valide.');
    const i=options.registry.find(id);
    if(!i || i.state==='DELETED') throw new ManagerError(410,'MANAGED_DATABASE_GONE','Cette base Test a été supprimée ou n’existe pas. Revenez au choix de base.');
    if(i.state!=='READY' || !i.port) throw new ManagerError(503,'MANAGED_DATABASE_UNAVAILABLE','Cette base Test est momentanément indisponible.');
    return i;
  }
  app.use((req,res,next)=>{
    if(!req.path.startsWith('/api/') && !req.path.startsWith('/socket.io/')) {res.status(404).end();return;}
    try {
      const i=destination(req),headers={...req.headers,host:`127.0.0.1:${i.port}`};delete headers['proxy-authorization'];
      const request=upstreamRequest({hostname:'127.0.0.1',port:i.port!,path:req.originalUrl,method:req.method,headers},response=>{res.writeHead(response.statusCode??502,response.headers);response.pipe(res);});
      request.on('socket',socket=>track(i.id,socket));request.on('error',()=>{if(!res.headersSent) res.status(503).json({code:'MANAGED_DATABASE_UNAVAILABLE',message:'Cette base Test est momentanément indisponible.'});else res.destroy();});req.once('aborted',()=>request.destroy());req.pipe(request);
    }catch(error){next(error);}
  });
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    const known=error instanceof ManagerError;res.status(known ? error.status:error instanceof z.ZodError ? 400:503).json({code:known ? error.code:error instanceof z.ZodError ? 'MANAGED_INVALID_REQUEST':'MANAGED_SERVICE_UNAVAILABLE',message:known ? error.message:'La demande ne peut pas être traitée. Vérifiez votre saisie puis réessayez.'});
  });
  server.on('upgrade',(req,socket,head)=>{try {
    if(!new URL(req.url??'/', 'http://localhost').pathname.startsWith('/socket.io/')) throw new ManagerError(404,'MANAGED_ROUTE_INVALID','Route invalide.');
    const i=destination(req),request=upstreamRequest({hostname:'127.0.0.1',port:i.port!,path:req.url,headers:{...req.headers,host:`127.0.0.1:${i.port}`}});
    request.on('upgrade',(response,upstream,upstreamHead)=>{track(i.id,upstream);socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${response.rawHeaders.reduce((s,v,n,a)=>n%2===0 ? `${s}${v}: ${a[n+1]}\r\n`:s,'')}\r\n`);if(upstreamHead.length) socket.write(upstreamHead);if(head.length) upstream.write(head);socket.pipe(upstream).pipe(socket);socket.once('close',()=>upstream.destroy());upstream.once('close',()=>socket.destroy());});
    request.on('response',()=>{socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');});request.on('error',()=>socket.destroy());request.end();
  }catch(error){socket.end(`HTTP/1.1 ${error instanceof ManagerError ? error.status:503} Unavailable\r\nConnection: close\r\n\r\n`);}});
  return {app,server,drain:()=>tail,async initialize(){await options.registry.initialize();if(options.enabled){try{const status=await options.helper.status();ready=status.ready;templateVersion=status.template_version;}catch{ready=false;}if(ready) for(const i of options.registry.snapshot().instances) if(['CREATING','DELETING'].includes(i.state)) enqueue(i);}},async shutdown(){stopping=true;for(const id of connections.keys()) closeConnections(id);while(activeMutations>0) await new Promise(r=>setTimeout(r,10));await tail;await options.registry.close();}};
}
