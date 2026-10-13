import { describe,expect,it } from 'vitest';
import { groupedMaterialBarPortions,groupedMaterialBarProposal,type GroupedMaterialLine } from './grouped-material-bars';
import { confirmGroupedReceiptSchema,type ConfirmGroupedReceipt } from '../validators/grouped-receipts.validators';
type Choice=ConfirmGroupedReceipt['lines'][number];
const line:GroupedMaterialLine={unit:'barre',stockUnit:'mm',coefficient:3000,stockManaged:true,qualityRequired:false,processingPolicy:'STANDARD',flowContext:{material:{barToCut:true,sourceLengthMm:3000}}};
const id='11111111-1111-4111-8111-111111111111';
const choice=(overrides:Partial<Choice>={}):Choice=>({lineId:id,expectedVersion:'v1',quantity:2,destination:{magasinId:id,emplacementId:1},supplierLotCode:'SUP-01',packs:[],overReceiptReason:null,...overrides});

describe('grouped physical-bar receipts',()=>{
    it('proposes known purchase-bar conversion or article length without inventing a last remnant',()=>{
        expect(groupedMaterialBarProposal(line,2)).toMatchObject({required:true,groups:[{lengthMm:3000,count:2}],source:'PURCHASE_CONVERSION'});
        const metres={...line,unit:'m',coefficient:1000};
        expect(groupedMaterialBarProposal(metres,6)).toMatchObject({groups:[{lengthMm:3000,count:2}],source:'ARTICLE'});
        expect(groupedMaterialBarProposal(metres,5)).toMatchObject({required:true,groups:null,source:null});
    });
    it('requires geometry before stock and checks the actual partial delivery conversion',()=>{
        expect(()=>groupedMaterialBarPortions(line,choice())).toThrow(/Confirmez le nombre/);
        const result=groupedMaterialBarPortions(line,choice({quantity:1,materialBars:[{lengthMm:3000,count:1}]}));
        expect(result).toEqual([{quantity:1,supplierLotCode:'SUP-01',materialBars:[{lengthMm:3000,count:1}]}]);
        expect(()=>groupedMaterialBarPortions(line,choice({quantity:1,materialBars:[{lengthMm:3000,count:2}]}))).toThrow(/dépasse/);
    });
    it('keeps different supplier lots and their own groups separate',()=>{
        const result=groupedMaterialBarPortions({...line,unit:'m',coefficient:1000},choice({quantity:5,packs:[
            {quantity:3,supplierLotCode:'SUP-A',materialBars:[{lengthMm:3000,count:1}]},
            {quantity:2,supplierLotCode:'SUP-B',materialBars:[{lengthMm:1000,count:2}]},
        ]}));
        expect(result.map(portion=>[portion.supplierLotCode,portion.materialBars])).toEqual([
            ['SUP-A',[{lengthMm:3000,count:1}]],['SUP-B',[{lengthMm:1000,count:2}]],
        ]);
    });
    it('rejects missing groups on one portion and ambiguous groups on the whole line',()=>{
        expect(()=>groupedMaterialBarPortions(line,choice({packs:[{quantity:1,supplierLotCode:'A',materialBars:[{lengthMm:3000,count:1}]},{quantity:1,supplierLotCode:'B'}]}))).toThrow(/chaque lot/);
        const ambiguous=choice({materialBars:[{lengthMm:3000,count:2}],packs:[{quantity:2,supplierLotCode:'B'}]});
        expect(()=>groupedMaterialBarPortions(line,ambiguous)).toThrow(/Répartissez/);
        expect(confirmGroupedReceiptSchema.safeParse({idempotencyKey:id,lines:[ambiguous]}).success).toBe(false);
    });
    it('receives quality-controlled bars physically first and defers geometry to accepted stock',()=>{
        const controlled={...line,qualityRequired:true};
        expect(groupedMaterialBarProposal(controlled,2)).toMatchObject({required:false,groups:null});
        expect(groupedMaterialBarPortions(controlled,choice())[0].quantity).toBe(2);
        expect(()=>groupedMaterialBarPortions(controlled,choice({materialBars:[{lengthMm:3000,count:2}]}))).toThrow(/matière acceptée/);
    });
    it('preserves unit receipts and piece packaging without bar fields',()=>{
        const pieces={...line,stockUnit:'u',coefficient:1,processingPolicy:'PIECES_CONTROLE_EMBALLAGE' as const};
        expect(groupedMaterialBarPortions(pieces,choice())).toHaveLength(1);
        expect(groupedMaterialBarProposal(pieces,2).required).toBe(false);
        expect(()=>groupedMaterialBarPortions(pieces,choice({materialBars:[{lengthMm:1,count:2}]}))).toThrow();
    });
    it('retains strict number precision and the total-bar count boundary',()=>{
        const rows=choice({materialBars:[{lengthMm:3000.0001,count:2}]});
        expect(confirmGroupedReceiptSchema.safeParse({idempotencyKey:id,lines:[rows]}).success).toBe(false);
        expect(()=>groupedMaterialBarPortions({...line,coefficient:1},choice({quantity:1200,materialBars:[{lengthMm:1,count:600},{lengthMm:1,count:600}]}))).toThrow(/1 000/);
    });
});
