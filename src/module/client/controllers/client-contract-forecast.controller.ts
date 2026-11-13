import type {RequestHandler} from 'express';
import {z} from 'zod';
import {clientContractAuditContext} from './client-contract.controller';
import {contractClientIdSchema,contractIdempotencySchema} from '../validators/client-contract.validators';
import {clientForecastCommandSchema,clientForecastQuerySchema} from '../validators/client-contract-forecast.validators';
import {executeClientForecastCommand,getClientForecasts} from '../services/client-contract-forecast.service';
export const listClientContractForecasts:RequestHandler=async(req,res,next)=>{
  try {
    const data=await getClientForecasts(contractClientIdSchema.parse(req.params.id),z.string().uuid().parse(req.params.contractId),
      clientForecastQuerySchema.parse(req.query),req.params.forecastId?z.string().uuid().parse(req.params.forecastId):undefined);
    res.setHeader('Cache-Control','private, no-store');res.json(data);
  } catch(error){next(error);}
};
export const postClientContractForecastCommand:RequestHandler=async(req,res,next)=>{
  try {
    const saved=await executeClientForecastCommand(contractClientIdSchema.parse(req.params.id),z.string().uuid().parse(req.params.contractId),
      clientForecastCommandSchema.parse(req.body),contractIdempotencySchema.parse(req.headers['idempotency-key']),clientContractAuditContext(req));
    res.setHeader('Cache-Control','private, no-store');res.setHeader('Idempotency-Replayed',saved.replayed?'true':'false');
    res.status(saved.replayed?200:201).json(saved.result);
  } catch(error){next(error);}
};
