import { describe, expect, it } from 'vitest';
import { planMaterialBarMovement, type MaterialBarMovementStock, type MaterialBarMovementCommand } from './material-bar-movement';
import { materialBarMovementCommandSchema } from '../validators/material-bar-movement.validators';

const barId='d72533cb-bdc7-4fbe-9f17-0028b7117001';
const revision='a'.repeat(64);
const stock=(overrides:Partial<MaterialBarMovementStock>={}):MaterialBarMovementStock=>({version:revision,status:'CONFIRMED',
  batch:{id:'source',articleId:'article',lotId:'lot',physicalMm:3000,reservedMm:0},bars:[{id:barId,batchId:'source',lengthMm:3000,version:4}],holds:[],reservations:[],...overrides});
const destination=():MaterialBarMovementStock=>stock({status:'UNCONFIRMED',batch:{...stock().batch,id:'destination',physicalMm:0,reservedMm:0},bars:[]});
const issue=(quantityMm=1000):MaterialBarMovementCommand=>({kind:'ISSUE',expectedVersion:revision,bars:[{barId,expectedVersion:4,quantityMm}]});
const transfer=():MaterialBarMovementCommand=>({kind:'TRANSFER',expectedVersion:revision,expectedDestinationVersion:revision,bars:[{barId,expectedVersion:4}]});
const held=():MaterialBarMovementStock=>stock({batch:{...stock().batch,reservedMm:2000},
  reservations:[{id:'reservation',batchId:'source',remainingMm:2000}],holds:[{barId,reservationId:'reservation',remainingMm:2000}]});

describe('physical geometry of normal stock movements',()=>{
  it('appends actual incoming bars without inferring their count from aggregate stock',()=>{
    const plan=planMaterialBarMovement({source:stock(),quantityMm:6000,command:{kind:'RECEIVE',expectedVersion:revision,bars:[{lengthMm:3000,count:2}]}});
    expect(plan).toEqual({kind:'RECEIVE',batchId:'source',quantityMm:6000,lengths:[3000,3000]});
  });
  it('initializes a truly empty destination and rejects an unknown old stock',()=>{
    const command:MaterialBarMovementCommand={kind:'RECEIVE',expectedVersion:revision,bars:[{lengthMm:3000,count:1}]};
    expect(planMaterialBarMovement({source:destination(),quantityMm:3000,command}).kind).toBe('RECEIVE');
    expect(()=>planMaterialBarMovement({source:stock({status:'UNCONFIRMED'}),quantityMm:3000,command})).toThrow('Confirmez');
  });
  it('withdraws only the free tail while keeping the existing OF reservation untouched',()=>{
    const source=held(),before=JSON.stringify(source);
    const plan=planMaterialBarMovement({source,quantityMm:1000,command:issue()});
    expect(plan.kind).toBe('ISSUE');if(plan.kind!=='ISSUE')throw Error('Unexpected plan');
    expect(plan.changes[0]).toMatchObject({remainingMm:2000,nextVersion:5,quantityMm:1000});
    expect(JSON.stringify(source)).toBe(before);
    expect(()=>planMaterialBarMovement({source,quantityMm:1001,command:issue(1001)})).toThrow('réservée');
  });
  it('handles exact fractional millimetres without losing a remainder',()=>{
    const source=stock({batch:{...stock().batch,physicalMm:110.501},bars:[{id:barId,batchId:'source',lengthMm:110.501,version:4}]});
    const plan=planMaterialBarMovement({source,quantityMm:110.5,command:issue(110.5)});
    expect(plan.kind==='ISSUE'&&plan.changes[0].remainingMm).toBe(.001);
  });
  it('moves a whole bar with its identity and length preserved',()=>{
    const plan=planMaterialBarMovement({source:stock(),destination:destination(),quantityMm:3000,command:transfer()});
    expect(plan).toEqual({kind:'TRANSFER',sourceBatchId:'source',destinationBatchId:'destination',quantityMm:3000,
      bars:[{id:barId,batchId:'destination',lengthMm:3000,version:5}]});
  });
  it('refuses a partial-bar transfer and any transfer of a reserved bar',()=>{
    expect(()=>planMaterialBarMovement({source:stock(),destination:destination(),quantityMm:1000,command:transfer()})).toThrow('dépassent');
    expect(()=>planMaterialBarMovement({source:held(),destination:destination(),quantityMm:3000,command:transfer()})).toThrow('réservée');
  });
  it('moves a free bar even if another bar in the same batch is reserved',()=>{
    const source=held();source.bars=[{id:barId,batchId:'source',lengthMm:2000,version:4},
      {id:'free-bar',batchId:'source',lengthMm:1000,version:2}];
    const command:MaterialBarMovementCommand={kind:'TRANSFER',expectedVersion:revision,expectedDestinationVersion:revision,
      bars:[{barId:'free-bar',expectedVersion:2}]};
    const plan=planMaterialBarMovement({source,destination:destination(),quantityMm:1000,command});
    expect(plan.kind==='TRANSFER'&&plan.bars).toEqual([{id:'free-bar',batchId:'destination',lengthMm:1000,version:3}]);
    expect(source.holds).toEqual([{barId,reservationId:'reservation',remainingMm:2000}]);
  });
  it('accepts an existing reconciled destination without changing its other bars',()=>{
    const target=destination();target.status='CONFIRMED';target.batch.physicalMm=1000;
    target.bars=[{id:'already-there',batchId:'destination',lengthMm:1000,version:7}];
    const before=JSON.stringify(target);
    expect(planMaterialBarMovement({source:stock(),destination:target,quantityMm:3000,command:transfer()}).kind).toBe('TRANSFER');
    expect(JSON.stringify(target)).toBe(before);
  });
  it('does not certify an unreconciled destination through a transfer',()=>{
    expect(()=>planMaterialBarMovement({source:stock(),destination:stock({status:'REVIEW_REQUIRED',batch:{...stock().batch,id:'destination',physicalMm:0}}),quantityMm:3000,command:transfer()})).toThrow('Confirmez');
  });
  it.each(['source','destination'])('rejects a stale %s inventory version',which=>{
    const command=transfer();if(command.kind!=='TRANSFER')throw Error('Unexpected command');
    if(which==='source')command.expectedVersion='b'.repeat(64);else command.expectedDestinationVersion='b'.repeat(64);
    expect(()=>planMaterialBarMovement({source:stock(),destination:destination(),quantityMm:3000,command})).toThrow('Actualisez');
  });
  it('rejects stale, absent and duplicate bar selections',()=>{
    for(const bars of [[{barId,expectedVersion:3,quantityMm:1000}],[{barId:'absent',expectedVersion:4,quantityMm:1000}],
      [{barId,expectedVersion:4,quantityMm:500},{barId,expectedVersion:4,quantityMm:500}]]){
      expect(()=>planMaterialBarMovement({source:stock(),quantityMm:1000,command:{kind:'ISSUE',expectedVersion:revision,bars}})).toThrow();
    }
  });
  it('requires exact movement totals and reconciled stock rather than trusting the status flag',()=>{
    expect(()=>planMaterialBarMovement({source:stock(),quantityMm:1001,command:issue()})).toThrow('exactement');
    expect(()=>planMaterialBarMovement({source:stock({batch:{...stock().batch,physicalMm:9000}}),quantityMm:1000,command:issue()})).toThrow('correspondent');
  });
  it.each([NaN,Infinity,0,-1,.0001,1e9+1])('rejects an invalid canonical quantity: %s',quantityMm=>{
    expect(()=>planMaterialBarMovement({source:stock(),quantityMm,command:issue()})).toThrow();
  });
  it.each(['articleId','lotId'] as const)('preserves the original %s during a transfer',field=>{
    const target=destination();target.batch[field]='another';
    expect(()=>planMaterialBarMovement({source:stock(),destination:target,quantityMm:3000,command:transfer()})).toThrow('lot matière');
  });
  it('does not transfer to the same stock batch',()=>{
    expect(()=>planMaterialBarMovement({source:stock(),destination:stock(),quantityMm:3000,command:transfer()})).toThrow('autre emplacement');
  });
});

describe('movement geometry command validation',()=>{
  it('accepts explicit issue and transfer shapes',()=>{
    expect(materialBarMovementCommandSchema.parse(issue())).toEqual(issue());
    expect(materialBarMovementCommandSchema.parse(transfer())).toEqual(transfer());
  });
  it('rejects duplicate IDs, hidden fields and numeric strings',()=>{
    const command=issue();
    expect(materialBarMovementCommandSchema.safeParse({...command,bars:[...command.bars,...command.bars]}).success).toBe(false);
    expect(materialBarMovementCommandSchema.safeParse({...command,skipValidation:true}).success).toBe(false);
    expect(materialBarMovementCommandSchema.safeParse({...command,bars:[{barId,expectedVersion:4,quantityMm:'1000'}]}).success).toBe(false);
  });
  it('requires both location revisions on a transfer and limits received bar counts',()=>{
    const {expectedDestinationVersion:_,...missing}=transfer() as Extract<MaterialBarMovementCommand,{kind:'TRANSFER'}>;
    expect(materialBarMovementCommandSchema.safeParse(missing).success).toBe(false);
    expect(materialBarMovementCommandSchema.safeParse({kind:'RECEIVE',expectedVersion:revision,bars:[{lengthMm:3000,count:1001}]}).success).toBe(false);
  });
});
